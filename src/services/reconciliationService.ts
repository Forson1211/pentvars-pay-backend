import { Transaction } from '../models/Transaction';
import { AuditLog } from '../models/AuditLog';
import { PaystackService } from './paystackService';

export interface ReconciliationReport {
    runAt: Date;
    paystackTransactionCount: number;
    dbTransactionCount: number;
    matchedCount: number;
    missingInDb: string[];        // References in Paystack but not in DB
    missingInPaystack: string[];  // References in DB (completed) but not in Paystack
    amountMismatches: Array<{ reference: string; dbAmount: number; paystackAmount: number }>;
    unverifiedCompleted: string[]; // Completed in DB but webhook not verified
    totalCollectedPaystack: number;
    totalCollectedDb: number;
    discrepancy: number;
}

/**
 * ReconciliationService
 * 
 * Background job that compares Paystack records with our database.
 * Flags any inconsistencies for admin review.
 * 
 * Run daily via cron or via POST /api/admin/reconcile
 */
export class ReconciliationService {

    /**
     * Run a full reconciliation for the past N days
     */
    static async runReconciliation(daysBack: number = 1): Promise<ReconciliationReport> {
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        from.setHours(0, 0, 0, 0);

        const to = new Date();

        console.log(`[Reconciliation] Running for ${from.toISOString()} → ${to.toISOString()}`);

        // ── 1. Fetch Paystack transactions ───────────────────────────────
        let paystackTransactions: any[] = [];
        let paystackTotal = 0;

        try {
            const psResponse = await PaystackService.listTransactions(from, to, 100, 1);
            if (psResponse.status) {
                paystackTransactions = (psResponse.data || []).filter((t: any) => t.status === 'success');
                paystackTotal = paystackTransactions.reduce((sum: number, t: any) => sum + (t.amount / 100), 0);
            }
        } catch (error: any) {
            console.error('[Reconciliation] Failed to fetch Paystack transactions:', error.message);
        }

        // ── 2. Fetch DB transactions for the same period ─────────────────
        const dbTransactions = await Transaction.find({
            createdAt: { $gte: from, $lte: to },
            status: { $in: ['completed', 'pending', 'processing'] },
        });

        const dbCompleted = dbTransactions.filter(t => t.status === 'completed');
        const dbTotal = dbCompleted.reduce((sum, t) => sum + t.amount, 0);

        // ── 3. Build lookup maps ──────────────────────────────────────────
        const psRefSet = new Set(paystackTransactions.map((t: any) => t.reference));
        const dbRefMap = new Map(dbTransactions.map(t => [t.reference, t]));

        // ── 4. Find discrepancies ─────────────────────────────────────────
        const missingInDb: string[] = [];
        const amountMismatches: Array<{ reference: string; dbAmount: number; paystackAmount: number }> = [];

        for (const psTx of paystackTransactions) {
            const reference = psTx.reference;
            const psAmount = psTx.amount / 100;

            if (!dbRefMap.has(reference)) {
                missingInDb.push(reference);
            } else {
                const dbTx = dbRefMap.get(reference)!;
                if (Math.abs(dbTx.amount - psAmount) > 0.01) {
                    amountMismatches.push({
                        reference,
                        dbAmount: dbTx.amount,
                        paystackAmount: psAmount,
                    });
                }
            }
        }

        // References in DB (completed) but not in Paystack
        const missingInPaystack: string[] = [];
        for (const dbTx of dbCompleted) {
            if (!psRefSet.has(dbTx.reference) && dbTx.paymentChannel === 'paystack') {
                missingInPaystack.push(dbTx.reference);
            }
        }

        // Transactions marked complete but webhook not verified
        const unverifiedCompleted = dbCompleted
            .filter(t => !t.webhookVerified)
            .map(t => t.reference);

        const discrepancy = Math.abs(paystackTotal - dbTotal);

        const report: ReconciliationReport = {
            runAt: new Date(),
            paystackTransactionCount: paystackTransactions.length,
            dbTransactionCount: dbCompleted.length,
            matchedCount: paystackTransactions.length - missingInDb.length,
            missingInDb,
            missingInPaystack,
            amountMismatches,
            unverifiedCompleted,
            totalCollectedPaystack: paystackTotal,
            totalCollectedDb: dbTotal,
            discrepancy,
        };

        // ── 5. Log the reconciliation run ────────────────────────────────
        await AuditLog.create({
            action: 'reconciliation_run',
            details: {
                daysBack,
                paystackCount: paystackTransactions.length,
                dbCount: dbCompleted.length,
                missingInDb: missingInDb.length,
                missingInPaystack: missingInPaystack.length,
                amountMismatches: amountMismatches.length,
                unverifiedCompleted: unverifiedCompleted.length,
                discrepancy,
            },
            isError: discrepancy > 0 || missingInDb.length > 0 || amountMismatches.length > 0,
        });

        // ── 6. Flag each inconsistency in audit logs ──────────────────────
        for (const ref of missingInDb) {
            await AuditLog.create({
                action: 'reconciliation_flag',
                reference: ref,
                details: { reason: 'Reference exists in Paystack but not in DB' },
                isError: true,
            }).catch(console.error);
        }

        for (const mismatch of amountMismatches) {
            await AuditLog.create({
                action: 'reconciliation_flag',
                reference: mismatch.reference,
                details: {
                    reason: 'Amount mismatch between Paystack and DB',
                    dbAmount: mismatch.dbAmount,
                    paystackAmount: mismatch.paystackAmount,
                },
                isError: true,
            }).catch(console.error);
        }

        // ── 7. Auto-fix: Re-verify unverified completed transactions ──────
        for (const ref of unverifiedCompleted.slice(0, 10)) { // limit to 10 per run
            try {
                const psVerify = await PaystackService.verifyTransaction(ref);
                if (psVerify.status && psVerify.data?.status === 'success') {
                    await Transaction.findOneAndUpdate(
                        { reference: ref },
                        {
                            webhookVerified: true,
                            paidAt: new Date(psVerify.data.paid_at),
                            providerReference: psVerify.data.id?.toString(),
                        }
                    );
                }
            } catch {
                // Skip if verification fails
            }
        }

        console.log(`[Reconciliation] Complete. Discrepancy: GHS ${discrepancy.toFixed(2)}, Missing in DB: ${missingInDb.length}, Mismatches: ${amountMismatches.length}`);

        return report;
    }

    /**
     * Schedule daily reconciliation (call once at server start)
     */
    static scheduleDailyReconciliation(): void {
        const runAt = new Date();
        runAt.setHours(2, 0, 0, 0); // 2 AM
        if (runAt < new Date()) runAt.setDate(runAt.getDate() + 1);

        const msUntilRun = runAt.getTime() - Date.now();

        setTimeout(() => {
            this.runReconciliation(1).catch(console.error);
            // Repeat every 24 hours
            setInterval(() => {
                this.runReconciliation(1).catch(console.error);
            }, 24 * 60 * 60 * 1000);
        }, msUntilRun);

        console.log(`[Reconciliation] Scheduled daily at 2 AM (next run in ${Math.round(msUntilRun / 60000)} minutes)`);
    }
}

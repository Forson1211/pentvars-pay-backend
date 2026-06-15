import https from 'https';
import crypto from 'crypto';
import { config } from '../config/env';

export interface PaystackInitializeResponse {
    status: boolean;
    message: string;
    data: {
        authorization_url: string;
        access_code: string;
        reference: string;
    };
}

export interface PaystackVerifyResponse {
    status: boolean;
    message: string;
    data: {
        id: number;
        domain: string;
        status: 'success' | 'failed' | 'abandoned';
        reference: string;
        amount: number; // in kobo
        message: string | null;
        gateway_response: string;
        paid_at: string;
        created_at: string;
        channel: string;
        currency: string;
        ip_address: string;
        metadata: Record<string, any>;
        fees: number;
        customer: {
            id: number;
            first_name: string;
            last_name: string;
            email: string;
            phone: string;
        };
        authorization: {
            authorization_code: string;
            bin: string;
            last4: string;
            exp_month: string;
            exp_year: string;
            channel: string;
            card_type: string;
            bank: string;
            country_code: string;
            brand: string;
            reusable: boolean;
            signature: string;
        };
    };
}

export interface PaystackTransactionListItem {
    id: number;
    reference: string;
    amount: number;
    status: string;
    paid_at: string;
    channel: string;
    currency: string;
    customer: {
        email: string;
        first_name: string;
        last_name: string;
    };
    metadata: Record<string, any>;
}

/**
 * Low-level Paystack API wrapper.
 * All amounts in GHS (converted to pesewas = *100 internally).
 */
export class PaystackService {
    private static readonly baseUrl = 'api.paystack.co';

    /**
     * Make a HTTPS request to Paystack
     */
    private static request<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: Record<string, any>
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const secretKey = config.paystack.secretKey;
            if (!secretKey || secretKey === 'sk_test_your_paystack_secret_key') {
                reject(new Error('Paystack secret key is not configured. Set PAYSTACK_SECRET_KEY in .env'));
                return;
            }

            const postData = body ? JSON.stringify(body) : '';

            const options: https.RequestOptions = {
                hostname: this.baseUrl,
                port: 443,
                path,
                method,
                headers: {
                    Authorization: `Bearer ${secretKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                const fs = require('fs');
                const logMsg = `[${new Date().toISOString()}] ${method} ${path} - Status: ${res.statusCode}\n`;
                fs.appendFileSync('pay_errors.log', logMsg);

                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        fs.appendFileSync('pay_errors.log', `[Error Body]: ${data}\n`);
                    }
                    try {
                        const parsed = JSON.parse(data) as T;
                        resolve(parsed);
                    } catch {
                        reject(new Error(`Failed to parse Paystack response: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            if (postData) req.write(postData);
            req.end();
        });
    }

    /**
     * Initialize a Paystack transaction.
     * @param amountGHS - Amount in Ghana Cedis (we convert to pesewas)
     * @param email - Customer email
     * @param reference - Unique transaction reference
     * @param metadata - Additional metadata stored with the transaction
     * @param channels - Payment channels to enable
     */
    static async initializeTransaction(
        amountGHS: number,
        email: string,
        reference: string,
        metadata: Record<string, any> = {},
        channels: string[] = ['card', 'mobile_money', 'bank_transfer', 'ussd'],
        callbackUrl?: string
    ): Promise<PaystackInitializeResponse> {
        const amountPesewas = Math.round(amountGHS * 100);

        const body: Record<string, any> = {
            email,
            amount: amountPesewas,
            reference,
            currency: 'GHS',
            channels,
            callback_url: callbackUrl,
            metadata: {
                ...metadata,
                cancel_action: metadata.cancel_action,
                custom_fields: [
                    {
                        display_name: 'Student ID',
                        variable_name: 'student_id',
                        value: metadata.studentId || '',
                    },
                    {
                        display_name: 'Fee Category',
                        variable_name: 'fee_category',
                        value: metadata.category || '',
                    },
                ],
            },
        };

        return this.request<PaystackInitializeResponse>('POST', '/transaction/initialize', body);
    }

    /**
     * Verify a Paystack transaction by reference.
     */
    static async verifyTransaction(reference: string): Promise<PaystackVerifyResponse> {
        return this.request<PaystackVerifyResponse>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    }

    /**
     * List transactions from Paystack (for reconciliation).
     */
    static async listTransactions(
        from?: Date,
        to?: Date,
        perPage: number = 50,
        page: number = 1
    ): Promise<{ status: boolean; data: PaystackTransactionListItem[]; meta: { total: number } }> {
        let path = `/transaction?perPage=${perPage}&page=${page}&currency=GHS`;
        if (from) path += `&from=${from.toISOString()}`;
        if (to) path += `&to=${to.toISOString()}`;
        return this.request<any>('GET', path);
    }

    /**
     * Verify Paystack webhook signature.
     * MUST be called before processing any webhook event.
     */
    static verifyWebhookSignature(rawBody: string, paystackSignature: string): boolean {
        const secretKey = config.paystack.secretKey;
        if (!secretKey) return false;

        const hash = crypto
            .createHmac('sha512', secretKey)
            .update(rawBody)
            .digest('hex');

        return hash === paystackSignature;
    }

    /**
     * Charge a mobile money number (GHS only).
     * Returns a pending charge that is completed via webhook.
     */
    static async chargeMobileMoney(
        amountGHS: number,
        email: string,
        reference: string,
        phone: string,
        provider: 'mtn' | 'vodafone' | 'airtel' | 'tigo' = 'mtn',
        metadata: Record<string, any> = {}
    ): Promise<any> {
        const amountPesewas = Math.round(amountGHS * 100);
        return this.request<any>('POST', '/charge', {
            email,
            amount: amountPesewas,
            reference,
            currency: 'GHS',
            mobile_money: {
                phone,
                provider,
            },
            metadata,
        });
    }
}

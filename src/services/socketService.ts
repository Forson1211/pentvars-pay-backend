import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';

// ────────────────────────────────────────────────────────────────────────────
// Singleton Socket.IO instance
// ────────────────────────────────────────────────────────────────────────────

let io: SocketIOServer | null = null;

/**
 * Initialise Socket.IO on the given HTTP server.
 * Call this once from server.ts right after app.listen().
 */
export const initSocket = (httpServer: HttpServer): SocketIOServer => {
    io = new SocketIOServer(httpServer, {
        cors: {
            origin: true,
            methods: ['GET', 'POST'],
            credentials: true,
        },
        // Allow long-polling as fallback for Expo Web / React Native
        transports: ['websocket', 'polling'],
        maxHttpBufferSize: 1e7, // 10MB to match express limit
    });

    io.on('connection', (socket: Socket) => {
        console.log(`🔌 [Socket.IO] Client connected:  ${socket.id}`);

        // Clients join rooms based on their role/ID
        socket.on('join', ({ userId, role }: { userId: string; role?: string }) => {
            if (userId) {
                socket.join(`user:${userId}`);
                if (role === 'admin') {
                    socket.join('admins');
                    console.log(`   ↳ Admin ${userId} joined room [admins]`);
                } else {
                    socket.join('students');
                    socket.join(`student:${userId}`);
                    console.log(`   ↳ Student ${userId} joined rooms [student:${userId}, students]`);
                }
            }
        });

        socket.on('disconnect', (reason) => {
            console.log(`🔌 [Socket.IO] Client disconnected: ${socket.id} (${reason})`);
        });
    });

    return io;
};

/**
 * Get the current Socket.IO instance (throws if not yet initialised).
 */
export const getIO = (): SocketIOServer => {
    if (!io) throw new Error('Socket.IO has not been initialised. Call initSocket() first.');
    return io;
};

// ────────────────────────────────────────────────────────────────────────────
// Emit helpers — call these from admin controllers after mutations
// ────────────────────────────────────────────────────────────────────────────

/** Payload sent with every fee-update event */
export interface FeeUpdatePayload {
    type: 'fee_type' | 'fee_template' | 'student_fee' | 'announcement';
    action: 'created' | 'updated' | 'deleted';
    /** If supplied, the event is sent only to that student's private room */
    studentId?: string;
    /** Optional extra data the client can use to optimistically update UI */
    data?: Record<string, unknown>;
}

/**
 * Broadcast a profile update event to the user's private room.
 */
export const emitProfileUpdate = (userId: string, data: any): void => {
    if (!io) return;
    io.to(`student:${userId}`).emit('profile:updated', { userId, data });
    console.log(`📡 [Socket.IO] Emitted profile:updated → student:${userId}`);
};

/**
 * Broadcast a fee-change event so student dashboards auto-refresh.
 *
 * - If `studentId` is provided  → emit only to that student's private room
 * - Otherwise                   → broadcast to the global "students" room
 */
export const emitFeeUpdate = (payload: FeeUpdatePayload): void => {
    if (!io) return; // noop during test bootstrap

    if (payload.studentId) {
        io.to(`student:${payload.studentId}`).emit('fee:updated', payload);
    } else {
        // Broadcast to all connected students
        io.to('students').emit('fee:updated', payload);
    }

    console.log(`📡 [Socket.IO] Emitted fee:updated →`, payload.type, payload.action,
        payload.studentId ? `→ student:${payload.studentId}` : '→ all students');
};

/**
 * Broadcast a payment-success event to all connected admins.
 * This ensures "instant reflection" on the admin dashboard.
 */
export const emitPaymentUpdate = (data: {
    transactionId: string;
    studentId: string;
    studentName: string;
    amount: number;
    description: string;
    reference: string;
    category: string;
}): void => {
    if (!io) return;
    io.to('admins').emit('payment:completed', data);
    console.log(`📡 [Socket.IO] Emitted payment:completed → admins [Ref: ${data.reference}]`);
};

/**
 * Broadcast a payment-cancelled event to all connected admins.
 * This ensures cancelled transactions appear in real-time on the admin side.
 */
export const emitPaymentCancelled = (data: {
    transactionId: string;
    studentId: string;
    studentName: string;
    amount: number;
    description: string;
    reference: string;
    category: string;
}): void => {
    if (!io) return;
    io.to('admins').emit('payment:cancelled', data);
    console.log(`📡 [Socket.IO] Emitted payment:cancelled → admins [Ref: ${data.reference}]`);
};

const express = require('express');
const midtransClient = require('midtrans-client');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// Singleton pattern for Firebase Admin to optimize Vercel Serverless
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
        console.log("Firebase Admin Initialized");
    } catch (error) {
        console.error("Firebase initialization error:", error);
    }
}

const db = admin.firestore();
const app = express();

// Middleware optimization
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Midtrans Client Initialization
const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Health Check
app.get('/', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Midtrans Backend v1.1.0 is active' });
});

// Endpoint: Charge / Create Transaction
app.post('/api/charge', async (req, res) => {
    try {
        const { order_id, amount, user_id, user_name, user_email } = req.body;

        if (!order_id || !amount || !user_id) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const parameter = {
            transaction_details: { order_id, gross_amount: amount },
            credit_card: { secure: true },
            customer_details: { first_name: user_name, email: user_email },
            metadata: { user_id }
        };

        const transaction = await snap.createTransaction(parameter);

        // Initial transaction record in Firestore
        await db.collection('transactions').doc(order_id).set({
            userId: user_id,
            userName: user_name,
            amount: parseFloat(amount),
            type: "TOP UP SALDO",
            status: "PENDING",
            date: new Date().toISOString(),
            midtrans_token: transaction.token
        });

        res.status(200).json(transaction);
    } catch (error) {
        console.error("Charge error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint: Webhook Notification Handler
app.post('/api/notification', async (req, res) => {
    try {
        const statusResponse = await snap.transaction.notification(req.body);
        const { order_id, transaction_status, fraud_status } = statusResponse;

        console.log(`Webhook received: ID ${order_id}, Status ${transaction_status}`);

        const trxRef = db.collection('transactions').doc(order_id);
        const doc = await trxRef.get();

        if (!doc.exists) return res.status(404).send('Not Found');

        const { userId, amount } = doc.data();

        if (transaction_status === 'capture' || transaction_status === 'settlement') {
            if (fraud_status === 'challenge') {
                await trxRef.update({ status: 'CHALLENGE' });
            } else {
                await handleSuccessPayment(userId, amount, trxRef);
            }
        } else if (['cancel', 'deny', 'expire'].includes(transaction_status)) {
            await trxRef.update({ status: 'FAILED' });
        } else if (transaction_status === 'pending') {
            await trxRef.update({ status: 'PENDING' });
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook error:", error);
        res.status(500).send("Internal Server Error");
    }
});

// Payment Success Handler using Firestore Transaction
async function handleSuccessPayment(userId, amount, trxRef) {
    const userRef = db.collection('users').doc(userId);
    try {
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");

            const newBalance = (userDoc.data().balance || 0) + amount;
            t.update(userRef, { balance: newBalance });
            t.update(trxRef, { status: 'SUCCESS' });
        });
    } catch (error) {
        console.error("Transaction update error:", error);
    }
}

// Export for Vercel Serverless
module.exports = app;

// Local development only
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Dev server on port ${PORT}`));
}

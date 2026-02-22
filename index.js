const express = require('express');
const midtransClient = require('midtrans-client');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');

// Konfigurasi Environment Variables (Penting untuk Railway)
require('dotenv').config();

// 1. Inisialisasi Firebase Admin menggunakan Environment Variables
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 2. Konfigurasi Midtrans menggunakan Environment Variables
let snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Root endpoint untuk cek server
app.get('/', (req, res) => {
    res.send('Midtrans Backend for Top Up Saldo App is Running!');
});

// 3. Endpoint untuk membuat transaksi (Token Snap)
app.post('/api/charge', async (req, res) => {
    try {
        const { order_id, amount, user_id, user_name, user_email } = req.body;

        let parameter = {
            "transaction_details": {
                "order_id": order_id,
                "gross_amount": amount
            },
            "credit_card": {
                "secure": true
            },
            "customer_details": {
                "first_name": user_name,
                "email": user_email
            },
            "metadata": {
                "user_id": user_id
            }
        };

        const transaction = await snap.createTransaction(parameter);

        // Simpan transaksi awal ke Firestore sebagai PENDING
        await db.collection('transactions').doc(order_id).set({
            userId: user_id,
            userName: user_name,
            amount: parseFloat(amount),
            type: "TOP UP SALDO",
            status: "PENDING",
            date: new Date().toISOString(),
            midtrans_token: transaction.token
        });

        res.json(transaction);
    } catch (error) {
        console.error("Error creating transaction:", error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Endpoint Webhook / Notification Handler (Dipanggil oleh Midtrans)
app.post('/api/notification', async (req, res) => {
    try {
        const statusResponse = await snap.transaction.notification(req.body);
        let orderId = statusResponse.order_id;
        let transactionStatus = statusResponse.transaction_status;
        let fraudStatus = statusResponse.fraud_status;

        console.log(`Transaction notification received. Order ID: ${orderId}. Status: ${transactionStatus}. Fraud: ${fraudStatus}`);

        const trxRef = db.collection('transactions').doc(orderId);
        const doc = await trxRef.get();

        if (!doc.exists) {
            return res.status(404).send('Transaction not found');
        }

        const trxData = doc.data();
        const userId = trxData.userId;
        const amount = trxData.amount;

        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                await trxRef.update({ status: 'CHALLENGE' });
            } else if (fraudStatus == 'accept') {
                await handleSuccessPayment(userId, amount, trxRef);
            }
        } else if (transactionStatus == 'settlement') {
            await handleSuccessPayment(userId, amount, trxRef);
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            await trxRef.update({ status: 'FAILED' });
        } else if (transactionStatus == 'pending') {
            await trxRef.update({ status: 'PENDING' });
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error("Notification Error:", error);
        res.status(500).send(error.message);
    }
});

async function handleSuccessPayment(userId, amount, trxRef) {
    const userRef = db.collection('users').doc(userId);

    // Gunakan Firestore Transaction untuk menambah saldo dengan aman
    await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw "User does not exist!";

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + amount;

        t.update(userRef, { balance: newBalance });
        t.update(trxRef, { status: 'SUCCESS' });
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

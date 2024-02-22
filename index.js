const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.SECRETKEY);
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

const salesforceCredentials = {
  client_id: '3MVG9p1Q1BCe9GmBa.vd3k6U6tisbR1DMPjMzaiBN7xn.uqsguNxOYdop1n5P_GB1yHs3gzBQwezqI6q37bh9', // Replace with your Salesforce Consumer Key
  client_secret: '1AAD66E5E5BF9A0F6FCAA681ED6720A797AC038BC6483379D55C192C1DC93190', // Replace with your Salesforce Consumer Secret
  username: 'admin@unblindedmastery.com', // Your Salesforce username
  password: 'Unblinded2023$', // Concatenate your password and security token
};

const getSalesforceAccessToken = async () => {
    const { data } = await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
        params: { grant_type: 'password', ...salesforceCredentials },
    });
    return data.access_token;
};

const getSalesforceAccountId = async (accessToken, email) => {
    const query = `SELECT Id FROM Account WHERE Email__c='${email}'`;
    const { data } = await axios.get(`https://unblindedmastery.my.salesforce.com/services/data/v58.0/query/?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data.records.length > 0 ? data.records[0].Id : null;
};

const postToChatter = async (accessToken, salesforceAccountId, product, amount) => {
    const payload = {
        body: {
            messageSegments: [{ type: 'Text', text: `Payment for product: ${product}, amount: ${amount}` }],
        },
        subjectId: salesforceAccountId,
        visibility: 'AllUsers',
    };
    await axios.post('https://unblindedmastery.my.salesforce.com/services/data/v58.0/chatter/feed-elements/', payload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
};

app.post('/charge', async (req, res) => {
    try {
        const { token, amount, email, firstName, lastName, product, oppId, startDate, numberOfPayments } = req.body;
        const salesforceAccessToken = await getSalesforceAccessToken();

        // Check if the customer already exists
        const customers = await stripe.customers.list({ email, limit: 1 });
        let customer;
      
        if (customers.data.length > 0) {
            customer = customers.data[0];
        } else {
            // Create a new customer without attaching the source (payment method)
            customer = await stripe.customers.create({
                email,
                name: `${firstName} ${lastName}`,
            });
        }

        // Create a PaymentMethod using the token
        const paymentMethod = await stripe.paymentMethods.create({
            type: 'card',
            card: {
                token: token,
            },
        });

        // Attach the PaymentMethod to the customer
        await stripe.paymentMethods.attach(paymentMethod.id, {
            customer: customer.id,
        });

        // Charge the customer once
        await stripe.paymentIntents.create({
            amount: Math.round(parseFloat(amount) * 100),
            currency: 'usd',
            customer: customer.id,
            payment_method: paymentMethod.id,
            confirm: true, // Automatically confirm the PaymentIntent
            description: `Payment for ${product}`,
            metadata: {
                oppId: oppId // Include oppId in the metadata
            }
        });

        const salesforceAccountId = await getSalesforceAccountId(salesforceAccessToken, email);
      
        // Create a single invoice item
        const invoiceItem = await stripe.invoiceItems.create({
            customer: customer.id,
            amount: Math.round(parseFloat(amount) * 100),
            currency: 'usd',
            description: `Payment for ${product}`,
        });

        // Calculate interval and create invoices
        const startDateObj = new Date(startDate);
        const invoices = [];
        for (let i = 0; i < numberOfPayments; i++) {
            const invoiceDate = new Date(startDateObj);
            invoiceDate.setMonth(startDateObj.getMonth() + i);
            const daysUntilDue = 30 * (i + 1); // Increase by 30 days for each subsequent invoice

            // Create invoice
            const invoice = await stripe.invoices.create({
                customer: customer.id,
                collection_method: 'send_invoice',
                days_until_due: daysUntilDue,
                description: `Payment for ${product}`,
                metadata: {
                    oppId: oppId // Include oppId in the metadata
                },
            });

            // Add the invoice item to the invoice
            await stripe.invoiceItems.create({
                invoice: invoice.id,
                customer: customer.id,
                amount: Math.round(parseFloat(amount) * 100)
            });

            // Send the invoice
            await stripe.invoices.sendInvoice(invoice.id);

            invoices.push(invoice);
        }

        if (salesforceAccountId) {
            await postToChatter(salesforceAccessToken, salesforceAccountId, product, amount);
        }

        res.json({ status: 'success', invoices: invoices.map(inv => inv.id) });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

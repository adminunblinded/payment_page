const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.SECRETKEY);
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

app.use(express.static('public'));

app.get('/payment', (req, res) => {
  // Serve the payment.html file when the /payment route is accessed
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});


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
    
    try {
        await axios.post('https://unblindedmastery.my.salesforce.com/services/data/v58.0/chatter/feed-elements/', payload, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        });
        console.log('Posted to Chatter successfully');
    } catch (error) {
        console.error('Failed to post to Chatter:', error.message);
    }
};

app.post('/charge', async (req, res) => {
    try {
        const { token, amount, email, firstName, lastName, product, oppId, startDate, numberOfPayments, recurringAmount} = req.body;
        let salesforceAccessToken;
        try {
            salesforceAccessToken = await getSalesforceAccessToken();
        } catch (accessTokenError) {
            console.error("Error obtaining Salesforce access token:", accessTokenError);
        }
      
        // Immediately acknowledge receipt of the payment request
        res.json({ status: 'processing', message: 'Payment processing in progress...' });

        // Process the payment asynchronously without waiting for it to finish
        processPayment(token, amount, email, firstName, lastName, product, oppId, startDate, numberOfPayments, recurringAmount, salesforceAccessToken, (err, invoices) => {
            if (err) {
                console.error("Error processing payment:", err);
                return;
            }
            console.log("Payment processing completed in the background.");
            console.log("Invoices:", invoices);
        });

    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

async function processPayment(token, amount, email, firstName, lastName, product, oppId, startDate, numberOfPayments, recurringAmount, salesforceAccessToken, callback) {
    try {
        let invoices = [];
        let salesforceAccountId;
        try {
            salesforceAccountId = await getSalesforceAccountId(salesforceAccessToken, email);
        } catch (accountIdError) {
            console.error("Error obtaining Salesforce access token:", accessTokenError);
        }

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
            card: { token },
        });

        const existingPaymentMethods = await stripe.paymentMethods.list({
            customer: customer.id,
            type: 'card',
        });

        let existingMethod = existingPaymentMethods.data.find(pm => pm.card.fingerprint === paymentMethod.card.fingerprint);
        if (!existingMethod) {
            existingMethod = await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
        }

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

        if (numberOfPayments && numberOfPayments > 1) {
            // Check if the product exists, if not, create it
            let stripeProduct;
            try {
                stripeProduct = await stripe.products.retrieve(product);
            } catch (error) {
                stripeProduct = await stripe.products.create({
                    name: product,
                });
            }

            // Create a price for the product
            const price = await stripe.prices.create({
                unit_amount: Math.round(parseFloat(recurringAmount) * 100),
                currency: 'usd',
                recurring: {
                    interval: 'month', // or any other interval as needed
                },
                product: stripeProduct.id,
            });

            const start = new Date(startDate + "T00:00:00Z"); // Ensures correct parsing with time set to 00:00:00 UTC
            const endDate = new Date(start);
            const numPayments = parseInt(numberOfPayments, 10);
          
            // Correctly add numberOfPayments months to the startDate
            endDate.setMonth(endDate.getMonth() + numPayments);

            // Stripe requires UNIX timestamps in seconds
            const cancel_at = Math.floor(endDate.getTime() / 1000); // Ensure this is the end date UNIX timestamp
            const billing_cycle_anchor=Math.floor(start.getTime() / 1000);
              
            console.log(`Cancel At (End Date): ${new Date(cancel_at * 1000).toISOString()}`);

            // Updated subscription creation with correct billing_cycle_anchor and cancel_at
            const subscription = await stripe.subscriptions.create({
                customer: customer.id,
                items: [{ price: price.id }],
                default_payment_method: existingMethod.id,
                billing_cycle_anchor: billing_cycle_anchor,
                cancel_at: cancel_at,
                metadata: {
                    oppId: oppId,
                },
            });
        }

        // If there is a Salesforce account ID, post payment details to Chatter
        if (salesforceAccountId) {
            await postToChatter(salesforceAccessToken, salesforceAccountId, product, amount);
        }
        // Once payment processing is complete, invoke the callback function
        callback(null, invoices);
    } catch (error) {
        // If an error occurs during payment processing, invoke the callback function with the error
        callback(error);
    }
}


app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

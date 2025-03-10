/**
 * Copyright 2020 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const { Logging } = require('@google-cloud/logging');
const logging = new Logging({
  projectId: process.env.GCLOUD_PROJECT,
});

const { Stripe } = require('stripe');
const stripe = new Stripe(functions.config().stripe.secret, {
  apiVersion: '2020-08-27',
});

const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const doordash = require('./doordash');

/**
 * When a user is created, create a Stripe customer object for them.
 *
 * @see https://stripe.com/docs/payments/save-and-reuse#web-create-customer
 */
exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
  const customer = await stripe.customers.create({ email: user.email });
  const intent = await stripe.setupIntents.create({
    customer: customer.id,
  });
  await admin.firestore().collection('stripe_customers').doc(user.uid).set({
    customer_id: customer.id,
    setup_secret: intent.client_secret,
  });
  return;
});

/**
 * When adding the payment method ID on the client,
 * this function is triggered to retrieve the payment method details.
 */
exports.addPaymentMethodDetails = functions.firestore
  .document('/stripe_customers/{userId}/payment_methods/{pushId}')
  .onCreate(async (snap, context) => {
    try {
      const paymentMethodId = snap.data().id;
      const paymentMethod = await stripe.paymentMethods.retrieve(
        paymentMethodId
      );
      await snap.ref.set(paymentMethod);
      // Create a new SetupIntent so the customer can add a new method next time.
      const intent = await stripe.setupIntents.create({
        customer: `${paymentMethod.customer}`,
      });
      await snap.ref.parent.parent.set(
        {
          setup_secret: intent.client_secret,
        },
        { merge: true }
      );
      return;
    } catch (error) {
      await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
      await reportError(error, { user: context.params.userId });
    }
  });

/**
 * When a payment document is written on the client,
 * this function is triggered to create the payment in Stripe.
 *
 * @see https://stripe.com/docs/payments/save-and-reuse#web-create-payment-intent-off-session
 */

// [START chargecustomer]

exports.createStripePayment = functions.firestore
  .document('stripe_customers/{userId}/payments/{pushId}')
  .onCreate(async (snap, context) => {
    const { amount, currency, payment_method } = snap.data();
    try {
      // Look up the Stripe customer id.
      const customer = (await snap.ref.parent.parent.get()).data().customer_id;
      // Create a charge using the pushId as the idempotency key
      // to protect against double charges.
      const idempotencyKey = context.params.pushId;
      const payment = await stripe.paymentIntents.create(
        {
          amount,
          currency,
          customer,
          payment_method,
          off_session: false,
          confirm: true,
          confirmation_method: 'manual',
        },
        { idempotencyKey }
      );
      // If the result is successful, write it back to the database.
      await snap.ref.set(payment);
    } catch (error) {
      // We want to capture errors and render them in a user-friendly way, while
      // still logging an exception to Error Reporting.
      functions.logger.log(error);
      await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
      await reportError(error, { user: context.params.userId });
    }
  });

// [END chargecustomer]

/**
 * When 3D Secure is performed, we need to reconfirm the payment
 * after authentication has been performed.
 *
 * @see https://stripe.com/docs/payments/accept-a-payment-synchronously#web-confirm-payment
 */
exports.confirmStripePayment = functions.firestore
  .document('stripe_customers/{userId}/payments/{pushId}')
  .onUpdate(async (change, context) => {
    if (change.after.data().status === 'requires_confirmation') {
      const payment = await stripe.paymentIntents.confirm(
        change.after.data().id
      );
      change.after.ref.set(payment);
    }
  });

/**
 * When a user deletes their account, clean up after them
 */
exports.cleanupUser = functions.auth.user().onDelete(async (user) => {
  const dbRef = admin.firestore().collection('stripe_customers');
  const customer = (await dbRef.doc(user.uid).get()).data();
  await stripe.customers.del(customer.customer_id);
  // Delete the customers payments & payment methods in firestore.
  const batch = admin.firestore().batch();
  const paymetsMethodsSnapshot = await dbRef
    .doc(user.uid)
    .collection('payment_methods')
    .get();
  paymetsMethodsSnapshot.forEach((snap) => batch.delete(snap.ref));
  const paymentsSnapshot = await dbRef
    .doc(user.uid)
    .collection('payments')
    .get();
  paymentsSnapshot.forEach((snap) => batch.delete(snap.ref));

  await batch.commit();

  await dbRef.doc(user.uid).delete();
  return;
});

/**
 * To keep on top of errors, we should raise a verbose error report with Error Reporting rather
 * than simply relying on functions.logger.error. This will calculate users affected + send you email
 * alerts, if you've opted into receiving them.
 */

// [START reporterror]

function reportError(err, context = {}) {
  // This is the name of the log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by Error Reporting.
  const logName = 'errors';
  const log = logging.log(logName);

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: { function_name: process.env.FUNCTION_NAME },
    },
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: 'cloud_function',
    },
    context: context,
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error) => {
      if (error) {
        return reject(error);
      }
      return resolve();
    });
  });
}

// [END reporterror]

/**
 * Sanitize the error message for the user.
 */
function userFacingMessage(error) {
  return error.type
    ? error.message
    : 'An error occurred, developers have been alerted';
}

/**
 * DoorDash相关函数
 */

// 请求配送报价
exports.requestDeliveryQuote = functions.https.onCall(async (data, context) => {
  // 确保用户已登录
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }

  try {
    const uid = context.auth.uid;
    const { businessId, storeId, deliveryDetails } = data;
    
    // 生成唯一的配送ID
    const deliveryId = uuidv4();
    
    // 请求DoorDash报价
    const quoteResponse = await doordash.requestQuote(
      deliveryId,
      businessId,
      storeId,
      deliveryDetails
    );
    
    // 将报价信息存储到Firestore
    await admin.firestore()
      .collection('doordash_deliveries')
      .doc(deliveryId)
      .set({
        userId: uid,
        businessId,
        storeId,
        deliveryDetails,
        quote: quoteResponse,
        status: 'QUOTE_RECEIVED',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 5 * 60 * 1000) // 5分钟后过期
      });
    
    return {
      deliveryId,
      quote: quoteResponse
    };
  } catch (error) {
    console.error('Error requesting delivery quote:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// 处理支付并接受报价
exports.processPaymentAndAcceptQuote = functions.https.onCall(async (data, context) => {
  // 确保用户已登录
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }

  const uid = context.auth.uid;
  const { deliveryId, paymentMethodId } = data;
  
  try {
    // 获取配送报价信息
    const deliveryDoc = await admin.firestore()
      .collection('doordash_deliveries')
      .doc(deliveryId)
      .get();
    
    if (!deliveryDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Delivery quote not found');
    }
    
    const deliveryData = deliveryDoc.data();
    
    // 检查报价是否过期
    if (deliveryData.expiresAt.toMillis() < Date.now()) {
      throw new functions.https.HttpsError('failed-precondition', 'Quote has expired');
    }
    
    // 获取用户的Stripe客户ID
    const customerDoc = await admin.firestore()
      .collection('stripe_customers')
      .doc(uid)
      .get();
    
    if (!customerDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Stripe customer not found');
    }
    
    const customerId = customerDoc.data().customer_id;
    
    // 计算支付金额（DoorDash费用）
    const amount = deliveryData.quote.fee;
    
    // 创建Stripe支付意向
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: false,
      confirm: true,
      confirmation_method: 'manual',
      metadata: {
        deliveryId,
        type: 'doordash_delivery'
      }
    });
    
    // 更新配送状态
    await admin.firestore()
      .collection('doordash_deliveries')
      .doc(deliveryId)
      .update({
        paymentIntent: paymentIntent,
        status: 'PAYMENT_PROCESSED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    
    // 接受DoorDash报价
    const acceptResponse = await doordash.acceptQuote(deliveryId);
    
    // 更新配送状态
    await admin.firestore()
      .collection('doordash_deliveries')
      .doc(deliveryId)
      .update({
        acceptResponse,
        status: 'QUOTE_ACCEPTED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    
    return {
      success: true,
      paymentIntent,
      acceptResponse
    };
  } catch (error) {
    console.error('Error processing payment and accepting quote:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// 获取配送状态
exports.getDeliveryStatus = functions.https.onCall(async (data, context) => {
  // 确保用户已登录
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }

  try {
    const { deliveryId } = data;
    
    // 从DoorDash获取最新状态
    const statusResponse = await doordash.getDeliveryStatus(deliveryId);
    
    // 确保所有更新的字段都有值
    const updateData = {
      currentStatus: statusResponse.status || 'UNKNOWN',  // 提供默认值
      statusDetails: statusResponse || {},  // 提供默认值
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // 更新Firestore中的状态
    await admin.firestore()
      .collection('doordash_deliveries')
      .doc(deliveryId)
      .update(updateData);
    
    return statusResponse;
  } catch (error) {
    console.error('Error getting delivery status:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// DoorDash Webhook处理
const app = express();
app.use(bodyParser.json());

app.post('/webhook', (req, res) => {
  const event = req.body;
  console.log('Received DoorDash webhook:', event);
  
  // 提取配送ID
  const deliveryId = event.external_delivery_id;
  
  // 更新Firestore中的配送状态
  admin.firestore()
    .collection('doordash_deliveries')
    .doc(deliveryId)
    .update({
      webhookEvents: admin.firestore.FieldValue.arrayUnion(event),
      currentStatus: event.event_name,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    })
    .then(() => {
      console.log(`Updated delivery ${deliveryId} with event ${event.event_name}`);
    })
    .catch(error => {
      console.error('Error updating delivery:', error);
    });
  
  // 根据事件类型处理不同的状态
  switch (event.event_name) {
    case 'DASHER_CONFIRMED':
      console.log('A Dasher has accepted your delivery and is on the way to the pickup location.');
      break;
    case 'DASHER_CONFIRMED_PICKUP_ARRIVAL':
      console.log('The Dasher has confirmed that they arrived at the pickup location and are attempting to pick up the delivery.');
      break;
    case 'DASHER_PICKED_UP':
      console.log('The Dasher has picked up the delivery.');
      break;
    case 'DASHER_CONFIRMED_DROPOFF_ARRIVAL':
      console.log('The Dasher has confirmed that they arrived at the dropoff location.');
      break;
    case 'DASHER_DROPPED_OFF':
      console.log('The Dasher has dropped off the delivery at the dropoff location and the delivery is complete.');
      break;
    case 'DELIVERY_CANCELLED':
      console.log('The delivery has been cancelled.');
      break;
    default:
      console.log('Unknown event:', event.event_name);
  }
  
  res.status(200).send('Webhook received');
});

exports.doordashWebhook = functions.https.onRequest(app);

// 创建商家和店铺
exports.createBusinessAndStore = functions.https.onCall(async (data, context) => {
  // 确保用户已登录
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }

  try {
    const uid = context.auth.uid;
    const { businessName, businessPhone, businessAddress } = data;
    
    // 使用用户ID作为商家ID
    const businessId = uid;
    // 创建唯一的店铺ID
    const storeId = uuidv4();
    
    // 创建商家
    const business = await doordash.createBusiness(businessId, businessName);
    
    // 创建店铺
    const store = await doordash.createStore(storeId, businessId, businessName, businessPhone, businessAddress);
    
    // 将商家和店铺信息存储到Firestore
    await admin.firestore()
      .collection('business_profiles')
      .doc(uid)
      .set({
        userId: uid,
        businessId,
        storeId,
        businessName,
        businessPhone,
        businessAddress,
        businessData: business,
        storeData: store,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    
    return {
      businessId,
      storeId,
      business,
      store
    };
  } catch (error) {
    console.error('Error creating business and store:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

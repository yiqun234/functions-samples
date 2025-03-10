const axios = require('axios');
const jwt = require('jsonwebtoken');
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// 创建DoorDash认证令牌
const createToken = () => {
  const data = {
    aud: 'doordash',
    iss: functions.config().doordash.issuer_id,
    kid: functions.config().doordash.key_id,
    exp: Math.floor(Date.now() / 1000 + 300),
    iat: Math.floor(Date.now() / 1000),
  };

  const headers = { algorithm: 'HS256', header: { 'dd-ver': 'DD-JWT-V1' } };

  return jwt.sign(
    data,
    Buffer.from(functions.config().doordash.signing_secret, 'base64'),
    headers,
  );
};

// 创建商家
const createBusiness = async (uid, business_name) => {
  const token = createToken();
  const businessData = {
    external_business_id: uid,
    name: business_name,
    description: "Restaurant that uses DoorDash API",
    activation_status: "active"
  };

  try {
    const response = await axios.post('https://openapi.doordash.com/developer/v1/businesses', businessData, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      }
    });
    console.log('Business created:', response.data);
    return response.data;
  } catch (error) {
    console.error('Failed to create business:', error);
    throw error;
  }
};

// 创建店铺
const createStore = async (uid, businessId, business_name, business_phone, business_full_address) => {
  const token = createToken();
  const storeData = {
    external_store_id: uid,
    name: business_name,
    phone_number: business_phone,
    address: business_full_address,
  };

  try {
    const response = await axios.post(`https://openapi.doordash.com/developer/v1/businesses/${businessId}/stores`, storeData, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      }
    });
    console.log('Store created:', response.data);
    return response.data;
  } catch (error) {
    console.error('Failed to create store:', error);
    throw error;
  }
};

// 请求配送报价
const requestQuote = async (uid, businessId, storeId, deliveryDetails) => {
  const token = createToken();
  const body = {
    external_delivery_id: uid,
    pickup_external_business_id: businessId,
    pickup_external_store_id: storeId,
    pickup_instructions: deliveryDetails.pickup_instructions || 'Call upon arrival',
    dropoff_address: deliveryDetails.dropoff_address,
    dropoff_phone_number: deliveryDetails.dropoff_phone_number,
    dropoff_instructions: deliveryDetails.dropoff_instructions || '',
    order_value: deliveryDetails.order_value,
    tip: deliveryDetails.tip || 0,
    items: deliveryDetails.items || []
  };

  try {
    const response = await axios.post('https://openapi.doordash.com/drive/v2/quotes', body, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error requesting quote:', error);
    throw error;
  }
};

// 接受配送报价
const acceptQuote = async (external_delivery_id) => {
  const token = createToken();
  const body = {};

  try {
    const response = await axios.post(`https://openapi.doordash.com/drive/v2/quotes/${external_delivery_id}/accept`, body, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error accepting quote:', error);
    throw error;
  }
};

// 获取配送状态
const getDeliveryStatus = async (external_delivery_id) => {
  const token = createToken();

  try {
    const response = await axios.get(`https://openapi.doordash.com/drive/v2/deliveries/${external_delivery_id}`, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error getting delivery status:', error);
    throw error;
  }
};

module.exports = {
  createToken,
  createBusiness,
  createStore,
  requestQuote,
  acceptQuote,
  getDeliveryStatus
}; 
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const createToken = () => {
  const data = {
    aud: 'doordash',
    iss: "c61ab9ea-4b61-43ca-8979-6ec7487c691e",
    kid: "e6045f2c-ea45-49ba-8303-5690732ae704",
    exp: Math.floor(Date.now() / 1000 + 300),
    iat: Math.floor(Date.now() / 1000),
  };

  const headers = { algorithm: 'HS256', header: { 'dd-ver': 'DD-JWT-V1' } };

  return jwt.sign(
    data,
    Buffer.from("jye9oPcVZ3nYsejqsYGMmm221SGDOeMRXlBmRwyyFng", 'base64'),
    headers,
  );
};


const createBusiness = async (uid, business_name) => {
  const token = createToken();
  const businessData = {
    external_business_id: uid,
    name: business_name,
    description: "Restaurant that uses EatifydashPos",
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
  }
};

const createStore = async (uid, businessId, business_name, business_phone, business_full_address) => {
  const token = createToken();
  const storeData = {
    external_store_id: uid,
    name: business_name,
    phone_number: business_phone,//"+12065551212",
    address: business_full_address,//"1346 Powell St, San 2Francisco, CA 94133"
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
  }
};


const requestQuote = async (uid, businessId, storeId, tip) => {
  const token = createToken();
  const body = {
    external_delivery_id: uid,
    pickup_external_business_id: businessId,
    pickup_external_store_id: storeId,
    pickup_instructions: 'Get in the store and give us a call',
    dropoff_address: '901 Market Street 6th Floor San Francisco, CA 94103',
    dropoff_phone_number: '+16505555555',
    dropoff_instructions: 'Enter gate code 1234 on the callbox.',
    order_value: 1999,
    tip: tip,
    items: [
      {
        "name": "Chicken Burrito",
        "quantity": 2,
        "external_id": "418575",
      }
    ]
  };

  try {
    const response = await axios.post('https://openapi.doordash.com/drive/v2/quotes', body, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    //console.log('Quote Response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error requesting quote:', error);
  }
};

const acceptQuote = async (external_delivery_id) => {
  const token = createToken();
  const body = {
    //tip: tip.toString(),
  };

  try {
    const response = await axios.post(`https://openapi.doordash.com/drive/v2/quotes/${external_delivery_id}/accept`, body, {
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    //console.log('Accept Quote Response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error accepting quote:', error);
  }
};

const main = async () => {
  const ramdom_business_id = "6c83f41f-c091-4175-b6cc-fe649de6043f"
  const ramdom_store_id = "869e9b26-ec52-4b6d-ae0d-247160a099ba"
  const tip = 100;
  const business_name = "taishan dimsum"
  const business_phone = "2065551212" // "+12065551212"
  const business_full_address = "1343 Powell St, San 2Francisco, CA 94133" //"1346 Powell St, San 2Francisco, CA 94133"
  const business = await createBusiness(ramdom_business_id, business_name);
  const store = await createStore(ramdom_store_id, ramdom_business_id, business_name, business_phone, business_full_address);

  // Request a quote
  const external_delivery_id = "123"//uuid
  const quoteResponse = await requestQuote(external_delivery_id, ramdom_business_id, ramdom_store_id, tip);

  console.log(quoteResponse.fee)
  console.log(quoteResponse.external_delivery_id)
  // setTimeout(async function () {// you have to accept quote within 5 minute or create another request quote and accept quote
  //   await acceptQuote('ee8612a6-8d70-4504-9e88-9a9ed7951591');

  //   // code to be executed after 30 seconds
  // }, 300);



};

main();

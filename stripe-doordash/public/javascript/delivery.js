/**
 * DoorDash配送集成前端代码
 */

// 初始化DoorDash配送功能
function initDoorDashDelivery() {
  // 获取当前用户的商家和店铺信息
  firebase.firestore()
    .collection('business_profiles')
    .where('userId', '==', currentUser.uid)
    .limit(1)
    .get()
    .then((snapshot) => {
      if (!snapshot.empty) {
        const businessData = snapshot.docs[0].data();
        document.getElementById('business-id').value = businessData.businessId;
        document.getElementById('store-id').value = businessData.storeId;
      } else {
        console.log('No business profile found for user');
      }
    });

  // 绑定表单提交事件
  document.getElementById('quote-form').addEventListener('submit', requestDeliveryQuote);
  document.getElementById('payment-form-delivery').addEventListener('submit', processPaymentAndAcceptQuote);
}

// 请求配送报价
async function requestDeliveryQuote(event) {
  event.preventDefault();
  
  document.getElementById('quote-error').textContent = '';
  document.getElementById('quote-loader').style.display = 'block';
  
  const form = new FormData(event.target);
  const businessId = form.get('business-id');
  const storeId = form.get('store-id');
  
  const deliveryDetails = {
    pickup_instructions: form.get('pickup-instructions'),
    dropoff_address: form.get('dropoff-address'),
    dropoff_phone_number: form.get('dropoff-phone'),
    dropoff_instructions: form.get('dropoff-instructions'),
    order_value: parseInt(form.get('order-value')),
    tip: parseInt(form.get('tip')),
    items: [
      {
        name: form.get('item-name'),
        quantity: parseInt(form.get('item-quantity')),
        external_id: form.get('item-id')
      }
    ]
  };
  
  try {
    const requestQuoteFunction = firebase.functions().httpsCallable('requestDeliveryQuote');
    const result = await requestQuoteFunction({
      businessId,
      storeId,
      deliveryDetails
    });
    
    // 显示报价结果
    const quoteData = result.data;
    document.getElementById('delivery-id').value = quoteData.deliveryId;
    document.getElementById('quote-amount').textContent = `$${(quoteData.quote.fee / 100).toFixed(2)}`;
    document.getElementById('quote-expiry').textContent = new Date(Date.now() + 5 * 60 * 1000).toLocaleTimeString();
    
    // 显示支付表单
    document.getElementById('quote-result').style.display = 'block';
    document.getElementById('payment-section').style.display = 'block';
    
    // 启动倒计时
    startQuoteCountdown();
  } catch (error) {
    document.getElementById('quote-error').textContent = error.message;
  } finally {
    document.getElementById('quote-loader').style.display = 'none';
  }
}

// 报价倒计时
function startQuoteCountdown() {
  const countdownElement = document.getElementById('quote-countdown');
  let timeLeft = 5 * 60; // 5分钟
  
  const countdownInterval = setInterval(() => {
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    countdownElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    if (timeLeft <= 0) {
      clearInterval(countdownInterval);
      document.getElementById('quote-expired').style.display = 'block';
      document.getElementById('payment-section').style.display = 'none';
    }
    
    timeLeft--;
  }, 1000);
}

// 处理支付并接受报价
async function processPaymentAndAcceptQuote(event) {
  event.preventDefault();
  
  document.getElementById('payment-error').textContent = '';
  document.getElementById('payment-loader').style.display = 'block';
  
  const form = new FormData(event.target);
  const deliveryId = form.get('delivery-id');
  const paymentMethodId = form.get('payment-method');
  
  try {
    const processPaymentFunction = firebase.functions().httpsCallable('processPaymentAndAcceptQuote');
    const result = await processPaymentFunction({
      deliveryId,
      paymentMethodId
    });
    
    // 显示成功信息
    document.getElementById('payment-success').style.display = 'block';
    document.getElementById('payment-section').style.display = 'none';
    
    // 开始轮询配送状态
    startDeliveryStatusPolling(deliveryId);
  } catch (error) {
    document.getElementById('payment-error').textContent = error.message;
  } finally {
    document.getElementById('payment-loader').style.display = 'none';
  }
}

// 轮询配送状态
function startDeliveryStatusPolling(deliveryId) {
  const statusElement = document.getElementById('delivery-status');
  statusElement.textContent = 'Initializing delivery...';
  document.getElementById('delivery-tracking').style.display = 'block';
  
  // 每30秒查询一次状态
  const pollingInterval = setInterval(async () => {
    try {
      const getStatusFunction = firebase.functions().httpsCallable('getDeliveryStatus');
      const result = await getStatusFunction({ deliveryId });
      
      // 确保我们有状态数据
      if (result && result.data && result.data.status) {
        const status = result.data.status;
        statusElement.textContent = formatDeliveryStatus(status);
        
        // 如果配送完成或取消，停止轮询
        if (status === 'COMPLETED' || status === 'CANCELLED') {
          clearInterval(pollingInterval);
        }
      } else {
        console.warn('Received incomplete status data:', result);
        statusElement.textContent = 'Status: Pending...';
      }
    } catch (error) {
      console.error('Error polling delivery status:', error);
      statusElement.textContent = 'Error getting status: ' + error.message;
    }
  }, 30000);

  // 立即执行一次状态检查
  getStatusFunction({ deliveryId }).catch(error => {
    console.error('Initial status check failed:', error);
  });
}

// 格式化配送状态
function formatDeliveryStatus(status) {
  if (!status) return 'Status: Unknown';
  
  switch (status) {
    case 'DASHER_CONFIRMED':
      return 'A Dasher has accepted your delivery and is on the way to the pickup location.';
    case 'DASHER_CONFIRMED_PICKUP_ARRIVAL':
      return 'The Dasher has arrived at the pickup location.';
    case 'DASHER_PICKED_UP':
      return 'The Dasher has picked up the delivery.';
    case 'DASHER_CONFIRMED_DROPOFF_ARRIVAL':
      return 'The Dasher has arrived at the dropoff location.';
    case 'DASHER_DROPPED_OFF':
      return 'The Dasher has completed the delivery!';
    case 'DELIVERY_CANCELLED':
      return 'The delivery has been cancelled.';
    default:
      return `Current status: ${status}`;
  }
}

// 当DOM加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  // 检查用户是否已登录
  firebase.auth().onAuthStateChanged((user) => {
    if (user) {
      initDoorDashDelivery();
    }


  });
});
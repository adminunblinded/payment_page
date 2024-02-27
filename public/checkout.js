document.addEventListener("DOMContentLoaded", function() {
  // Initialize Stripe.js
  var stripe = Stripe('pk_test_dnxIicCufTTvDdOvJJQmsGIt');

  // Create an instance of Elements
  var elements = stripe.elements();

  // Create and mount the card number Element with custom style
  var cardNumberElement = elements.create('cardNumber');
  cardNumberElement.mount('#cardNumberElement');

  // Create and mount the CVC Element with custom style
  var cardCvcElement = elements.create('cardCvc');
  cardCvcElement.mount('#cardCvcElement');

  // Create and mount the expiration date Element with custom style
  var cardExpiryElement = elements.create('cardExpiry');
  cardExpiryElement.mount('#cardExpiryElement');

  // Function to toggle recurring payment options
  function toggleRecurringOptions() {
    var recurringOptions = document.getElementById('recurringOptions');
    if (document.getElementById('recurringPayments').checked) {
      recurringOptions.style.display = 'block';
    } else {
      recurringOptions.style.display = 'none';
    }
  }
});

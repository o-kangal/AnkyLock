// Google redirects the sign-in popup here with the result in the URL fragment, which never
// reaches any server. Hand it to the app over a same-origin channel and close the popup.
(function () {
  var fragment = window.location.hash.slice(1);
  history.replaceState(null, '', window.location.pathname);
  var channel = new BroadcastChannel('ankylock-oauth');
  channel.postMessage({ fragment: fragment });
  channel.close();
  window.close();
})();

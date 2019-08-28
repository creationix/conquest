importScripts('https://storage.googleapis.com/workbox-cdn/releases/4.3.1/workbox-sw.js');


workbox.precaching.precacheAndRoute([
  '/',
  '/art/sprites.png',
  '/art/style.css',
  '/client.js',
  '/icons/icon-256.png',
  '/maps/first.json',
  '/utils.js',
]);

workbox.routing.registerRoute(
  /.*/,
  new workbox.strategies.StaleWhileRevalidate()
);


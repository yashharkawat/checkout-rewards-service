import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';

const config = loadConfig();
const db = openDb(process.env.DB_PATH ?? 'data/checkout.db');
const app = buildApp(db, config);

const address = await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
});
console.log(
  `listening on ${address} (coupon: ${config.discountPercent}% off every ${config.ordersPerCoupon} orders)`,
);

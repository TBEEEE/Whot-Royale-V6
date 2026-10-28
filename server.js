import { createGameServer } from './app.js';

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

const server = createGameServer({
  ...(process.env.TURN_SECONDS && { turnMs: num(process.env.TURN_SECONDS, 45) * 1000 }),
  ...(process.env.AUTO_START_SECONDS && { autoStartMs: num(process.env.AUTO_START_SECONDS, 15) * 1000 }),
});
const port = await server.listen(process.env.PORT || 3000);
console.log('WHOT Royale listening on', port);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close().then(() => process.exit(0)));

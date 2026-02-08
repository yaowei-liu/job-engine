const express = require('express');
const path = require('path');
const { initDB } = require('./lib/db');
const jobsRouter = require('./routes/jobs');

const app = express();
app.use(express.json());

(async () => {
  await initDB();

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/jobs', jobsRouter);
  app.use('/', express.static(path.join(__dirname, 'ui')));

  const port = process.env.PORT || 3030;
  app.listen(port, () => {
    console.log(`Job Engine listening on ${port}`);
  });
})().catch((err) => {
  console.error('Failed to init DB', err);
  process.exit(1);
});

const express = require('express');
const { initDB } = require('./lib/db');
const jobsRouter = require('./routes/jobs');

const app = express();
app.use(express.json());

initDB();

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/jobs', jobsRouter);

const port = process.env.PORT || 3030;
app.listen(port, () => {
  console.log(`Job Engine listening on ${port}`);
});

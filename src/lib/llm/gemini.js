const { execFile } = require('child_process');

function runGemini(prompt, model = 'gemini-1.5-pro') {
  return new Promise((resolve, reject) => {
    execFile('gemini', ['--model', model, '--output-format', 'json', prompt], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        return resolve(data);
      } catch (e) {
        return reject(new Error(`Gemini JSON parse failed: ${stderr || e.message}`));
      }
    });
  });
}

function buildPrompt(jdText) {
  return `You are a job matching assistant. Score this JD for a candidate seeking backend/systems roles (general SDE/full-stack acceptable but lower priority). Output ONLY valid JSON with keys: score (0-100), tier (A or B), reasons (array of short strings), negatives (array).\n\nJD:\n${jdText}`;
}

async function scoreWithGemini(jdText, model) {
  const prompt = buildPrompt(jdText);
  return runGemini(prompt, model);
}

module.exports = { scoreWithGemini };

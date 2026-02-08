async function fetchGreenhouseJobs(company) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Greenhouse fetch failed: ${res.status}`);
  const data = await res.json();
  return data.jobs || [];
}

module.exports = { fetchGreenhouseJobs };

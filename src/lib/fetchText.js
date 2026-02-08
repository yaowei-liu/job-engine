async function fetchTextFromUrl(url) {
  if (!url) return '';
  const res = await fetch(url);
  if (!res.ok) return '';
  const html = await res.text();
  // naive strip tags
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim();
  return text.slice(0, 8000); // cap for prompt
}

module.exports = { fetchTextFromUrl };

const DEFAULT_TARGETS = [];

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function extractOrgSlug(target) {
  if (!target) return null;
  const raw = String(target).trim();
  if (!raw) return null;

  if (!raw.includes('://')) return raw;

  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith('ashbyhq.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

function flattenJobs(payload) {
  const directJobs =
    payload?.data?.jobBoard?.jobs ||
    payload?.data?.jobBoardWithTeams?.jobs ||
    payload?.results?.[0]?.data?.jobBoard?.jobs;

  if (Array.isArray(directJobs)) return directJobs;

  const teams =
    payload?.data?.jobBoardWithTeams?.teams ||
    payload?.data?.jobBoard?.teams ||
    payload?.results?.[0]?.data?.jobBoardWithTeams?.teams;

  if (!Array.isArray(teams)) return [];
  return teams.flatMap((t) => (Array.isArray(t?.jobs) ? t.jobs : []));
}

function buildApiPayload(orgSlug) {
  return {
    operationName: 'ApiJobBoardWithTeams',
    variables: {
      organizationHostedJobsPageName: orgSlug,
      includeCompensation: false,
    },
    query: `
      query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!, $includeCompensation: Boolean!) {
        jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
          teams {
            id
            name
            jobs {
              id
              title
              location
              locationName
              postedDate
              publishedDate
              updatedAt
              applyUrl
              jobUrl
              descriptionHtml
              description
            }
          }
        }
      }
    `,
  };
}

async function fetchJobs(target) {
  const orgSlug = extractOrgSlug(target);
  if (!orgSlug) {
    console.error(`[Ashby] Invalid target: ${target}`);
    return [];
  }

  try {
    const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildApiPayload(orgSlug)),
    });
    if (!res.ok) {
      console.error(`[Ashby] API error for ${orgSlug}: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const jobs = flattenJobs(data);
    const mapped = jobs
      .filter((j) => j?.title)
      .map((job) => ({
        company: orgSlug,
        title: job.title,
        location: job.locationName || job.location || null,
        post_date: normalizeDate(job.publishedDate || job.postedDate || job.updatedAt),
        source: 'ashby',
        url: job.applyUrl || job.jobUrl || null,
        jd_text: stripHtml(job.descriptionHtml || job.description || '').slice(0, 2000) || null,
        meta: {
          ashby_job_id: job.id || null,
        },
      }));

    console.log(`[Ashby] Fetched ${mapped.length} jobs from ${orgSlug}`);
    return mapped;
  } catch (err) {
    console.error(`[Ashby] Failed to fetch ${orgSlug}:`, err.message);
    return [];
  }
}

async function fetchAll(targets = DEFAULT_TARGETS) {
  const results = await Promise.all(targets.map((t) => fetchJobs(t).catch(() => [])));
  return results.flat();
}

module.exports = {
  DEFAULT_TARGETS,
  extractOrgSlug,
  fetchAll,
  fetchJobs,
  flattenJobs,
};

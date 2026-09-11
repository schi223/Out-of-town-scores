export default async function handler(req, res) {
  const API_URL =
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=500';

  const escapePointer = (segment) =>
    String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

  const q = (name) => {
    const v = req.query?.[name];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  const dateFilter = q('date'); // Format: YYYY-MM-DD
  const conferenceIdFilter = q('conferenceId'); // Format: string
  const idFilter = q('id'); // Format: string

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  try {
    const apiRes = await fetch(API_URL);
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ error: `Upstream API returned ${apiRes.status}` });
    }

    const data = await apiRes.json();

    const competitions = data?.events?.flatMap(event => event.competitions || []) || [];

    const filteredCompetitions = competitions.filter(comp => {
  
  const matchDate = dateFilter
    ? comp.date?.slice(0, 10) === dateFilter
    : true;


  const matchId = idFilter
    ? String(comp.id) === String(idFilter)
    : true;

  const matchConference = conferenceIdFilter
    ? comp.competitors?.some(c =>
        String(c.team?.conferenceId) === String(conferenceIdFilter)
      )
    : true;

  return matchDate && matchId && matchConference;
});


    // Build index
    const index = {
      generatedAt: new Date().toISOString(),
      byId: {},
      byUid: {},
      byType: {},
      events: {},
      grouped: {
        events: [],
      },
    };

    const buildIndex = (node, path, index) => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => buildIndex(item, `${path}/${i}`, index));
        return;
      }
      if (node && typeof node === 'object') {
        const idKey = node.id !== undefined ? String(node.id) : null;
        const uidKey = node.uid !== undefined ? String(node.uid) : null;
        if (idKey) index.byId[idKey] = path;
        if (uidKey) index.byUid[uidKey] = path;

        const t = node.type || 'unknown';
        if (!index.byType[t]) index.byType[t] = {};
        if (idKey) index.byType[t][idKey] = path;

        const isEventLike =
          (typeof node.type === 'string' && node.type.toLowerCase() === 'event') ||
          path.includes('/events/');
        if (isEventLike) {
          const eventId = node.id !== undefined ? String(node.id) : node.uid || null;
          if (eventId && !index.events[eventId]) {
            const date = node.date || node.startDate || (node.competitions && node.competitions[0]?.date) || null;
            const status =
              (node.status && (node.status.type?.state || node.status.type?.name || node.status.type)) ||
              node.status?.detail ||
              node.status?.description ||
              null;

            let name = node.name || node.shortName || node.displayName || null;
            const competitors = [];

            try {
              const comp = node.competitions && node.competitions[0];
              if (comp && Array.isArray(comp.competitors)) {
                for (const c of comp.competitors) {
                  const teamObj = c.team || {};
                  const compId = c.id ?? teamObj.id ?? null;
                  const compUid = c.uid ?? teamObj.uid ?? null;
                  const teamName =
                    teamObj.displayName ||
                    teamObj.shortDisplayName ||
                    teamObj.name ||
                    c.name ||
                    null;
                  const rank = typeof teamObj.rank === 'number' ? teamObj.curatedRank : null;
                  competitors.push({
                    id: compId !== null ? String(compId) : null,
                    uid: compUid !== null ? String(compUid) : null,
                    homeAway: c.homeAway || null,
                    pointer: compId ? index.byId[String(compId)] || null : null,
                    teamName,
                    curatedRank,
                  });
                }
              }
            } catch (e) {}

            if (!name && competitors.length) {
              const home = competitors.find(c => c.homeAway === 'home') || competitors[1] || competitors[0];
              const away = competitors.find(c => c.homeAway === 'away') || competitors[0] || competitors[1] || competitors[0];
              const hName = home?.teamName || 'Home';
              const aName = away?.teamName || 'Away';
              name = `${aName} at ${hName}`;
            }

            index.events[eventId] = {
              pointer: path,
              uid: node.uid || null,
              date,
              name,
              status,
              competitionsCount: node.competitions ? node.competitions.length : 0,
              competitors,
            };

            index.grouped.events.push(path);
          }
        }

        const seg = path.split('/').filter(Boolean)[0];
        if (seg) {
          if (!index.grouped[seg]) index.grouped[seg] = [];
          if (!index.grouped[seg].includes(path)) index.grouped[seg].push(path);
        }

        for (const k of Object.keys(node)) {
          buildIndex(node[k], `${path}/${escapePointer(k)}`, index);
        }
      }
    };

    buildIndex(data, '', index);

    const prettyRaw = q('pretty');
    const pretty = (prettyRaw === undefined || prettyRaw === null) ? 'true' : prettyRaw;

    const indexOnlyRaw = q('indexOnly');
    const indexOnlyFlag =
      indexOnlyRaw === true ||
      indexOnlyRaw === 'true' ||
      indexOnlyRaw === '1' ||
      (typeof indexOnlyRaw === 'string' && indexOnlyRaw.toLowerCase() === 'yes');

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (indexOnlyFlag) {
      if (pretty === 'true' || pretty === '1' || pretty === 'yes') {
        return res.status(200).send(JSON.stringify(index, null, 2));
      }
      return res.status(200).json(index);
    }

    if (pretty === 'index') {
      const payload = { index, data: '<raw data omitted for readability; use ?pretty=true to view full data>' };
      return res.status(200).send(JSON.stringify(payload, null, 2));
    }

    if (pretty === 'true' || pretty === '1' || pretty === 'yes') {
      return res.status(200).send(JSON.stringify({ index, competitions: filteredCompetitions }, null, 2));
    }

    return res.status(200).json({ index, competitions: filteredCompetitions });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: 'Failed to fetch upstream API' });
  }
}


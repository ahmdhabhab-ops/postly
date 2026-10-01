import ExcelJS from 'exceljs';

// Cells that start with = + - @ are formulas in Excel; prefix them so text from AI/users can never run as a formula.
const cell = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

export function launchSteps(platform) {
  if (/instagram|facebook/i.test(platform)) {
    return [
      'Open Meta Ads Manager (adsmanager.facebook.com) and click Create.',
      'Choose the objective from the plan (Leads, Traffic or Sales).',
      'Set the daily budget and duration from the "Budget" rows.',
      'Audience: set the location, age range, gender and interests from the plan.',
      'Placements: choose manual placements and tick the ones listed in the plan.',
      'Create the ad: upload your images/video, then paste the headline, main text and button from the plan.',
      'Destination: your website, WhatsApp or lead form (see "Send people to").',
      'Install the Meta Pixel on your website first if the website check asked for it, then publish and review results after 3 days.',
    ];
  }
  if (/google/i.test(platform)) {
    return [
      'Open Google Ads (ads.google.com) and create a Search campaign.',
      'Choose the goal from the plan and set the daily budget.',
      'Locations and language: use the locations from the plan.',
      'Add the search keywords from the plan, then write ads using the headline and main text.',
      'Set the final URL to the page in "Send people to" and publish.',
    ];
  }
  if (/tiktok/i.test(platform)) {
    return [
      'Open TikTok Ads Manager and create a campaign with the objective from the plan.',
      'Set the daily budget, location, age range and interests from the plan.',
      'Upload a short vertical video (see creative ideas) and paste the text and button.',
      'Set the destination URL and publish.',
    ];
  }
  return ['Open the advertising platform, create a campaign with the objective and budget from this plan, use the audience, text and button listed, then publish and review after 3 days.'];
}

export async function buildPlanWorkbook({ campaign: c, brief: b, business = {}, notes = [] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Postly';
  wb.created = new Date();

  const ws = wb.addWorksheet('Campaign plan', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Item', key: 'k', width: 28 }, { header: 'Details', key: 'v', width: 90 }];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8A5A12' } };
  const add = (k, v) => {
    if (Array.isArray(v)) v = v.join(', ');
    if (v === undefined || v === null || v === '') return;
    const r = ws.addRow({ k: cell(k), v: cell(v) });
    r.getCell('v').alignment = { wrapText: true, vertical: 'top' };
    r.getCell('k').alignment = { vertical: 'top' };
    r.getCell('k').font = { bold: true };
  };
  const section = (t) => {
    const r = ws.addRow({ k: cell(t), v: '' });
    r.font = { bold: true, color: { argb: 'FF8A5A12' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCEFD6' } };
  };

  section('Campaign');
  add('Name', c.title); add('Platform', c.platform);
  add('Status', c.status === 'live' ? 'Approved in Postly (not published yet)' : 'Awaiting approval');
  add('Budget', `$${c.budget_per_day} per day`); add('Duration', `${c.duration_days} days`);
  add('Total budget', `$${c.budget_per_day * c.duration_days}`);
  add('Business', business.name); add('Website', business.website);
  if (b) {
    const a = b.audience;
    section('Objective and audience');
    add('Objective', b.objective);
    add('Age range', `${a.age_min}-${a.age_max}`); add('Gender', a.genders); add('Locations', a.locations);
    add(/google/i.test(c.platform) ? 'Search keywords' : 'Interests', a.interests); add('Targeting notes', a.notes);
    section('Where and how it shows');
    add('Placements', b.placements); add('Ad formats', b.creative.formats);
    b.creative.ideas.forEach((x, i) => add(`Creative idea ${i + 1}`, x));
    section('Ad copy');
    add('Headline', b.copy.headline); add('Main text', b.copy.primary_text); add('Button', b.copy.cta); add('Send people to', b.landing);
    section('Measure');
    add('What to track', b.kpis);
    if (b.assumptions.length || b.questions.length) {
      section('Check these');
      b.assumptions.forEach((x, i) => add(`Assumption ${i + 1}`, x));
      b.questions.forEach((x, i) => add(`Question ${i + 1}`, x));
    }
  }
  if (notes.length) { section('Before you launch: website'); notes.forEach((x, i) => add(`Note ${i + 1}`, x)); }

  const st = wb.addWorksheet('Steps to launch');
  st.columns = [{ header: '#', key: 'n', width: 6 }, { header: 'Step', key: 's', width: 100 }, { header: 'Done', key: 'd', width: 10 }];
  st.getRow(1).font = { bold: true };
  launchSteps(c.platform).forEach((s, i) => { const r = st.addRow({ n: i + 1, s: cell(s), d: '' }); r.getCell('s').alignment = { wrapText: true, vertical: 'top' }; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const safeFilename = (s) => String(s || 'campaign-plan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'campaign-plan';

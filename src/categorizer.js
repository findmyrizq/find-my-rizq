// Find My Rizq — auto-categorisation + tagging

const CATEGORY_RULES = {
  'Technology & IT': ['developer','software','engineer','devops','python','java','javascript','react','php','programmer','data scientist','machine learning','cloud','aws','cyber','sysadmin','it support','frontend','backend','full stack','qa engineer'],
  'Healthcare & Medical': ['nurse','doctor','physician','medical','healthcare','clinical','pharmacy','dental','care assistant','therapist','paramedic','radiographer','midwife','surgeon'],
  'Finance & Accounting': ['accountant','finance','audit','bookkeeper','financial analyst','tax','payroll','actuary','treasury'],
  'Sales & Marketing': ['sales','marketing','account manager','business development','seo','ppc','brand','social media','copywriter','growth','crm','telesales'],
  'Education & Training': ['teacher','lecturer','tutor','teaching assistant','education','professor','trainer','instructor','nursery'],
  'Engineering': ['mechanical engineer','electrical engineer','civil engineer','cad','manufacturing','maintenance engineer','process engineer','structural','automation'],
  'Hospitality & Catering': ['chef','waiter','waitress','kitchen','hospitality','hotel','restaurant','catering','housekeeping'],
  'Construction & Trades': ['electrician','plumber','carpenter','builder','construction','labourer','bricklayer','site manager','plasterer','roofer','welder'],
  'Transport & Logistics': ['driver','hgv','logistics','warehouse','delivery','forklift','courier','supply chain','fleet','lgv'],
  'Customer Service': ['customer service','call centre','call center','support agent','help desk','receptionist','contact centre'],
  'Admin & Office': ['administrator','office manager','secretary','data entry','executive assistant','clerk','coordinator'],
  'Legal': ['solicitor','lawyer','paralegal','legal','barrister','compliance','conveyancing'],
  'Human Resources': ['human resources','recruiter','talent','people partner','recruitment'],
  'Government & Public': ['government','public sector','council','civil service','federal','policy'],
};

const TAG_DICT = ['Remote','Hybrid','Full Time','Part Time','Contract','Temporary','Permanent','Internship','Apprenticeship',
  'Python','JavaScript','PHP','React','Node.js','SQL','AWS','Azure','Excel','SAP','Salesforce',
  'Entry Level','Senior','Graduate','Manager','Director','Weekend','Night Shift'];

export function categorize(job) {
  const hay = `${job.title} ${job.title} ${job.description}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_RULES)) {
    let score = 0;
    for (const kw of kws) if (hay.includes(kw)) score += kw.length > 5 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best || 'Other';
}

export function tagsFor(job) {
  const hay = `${job.title} ${job.description} ${job.job_type} ${job.location}`.toLowerCase();
  const found = new Set();
  for (const t of TAG_DICT) if (hay.includes(t.toLowerCase())) found.add(t);
  if (job.remote) found.add('Remote');
  if (job.company) found.add(job.company);
  return [...found];
}

export function jobType(job) {
  if (job.job_type) return job.job_type;
  const h = `${job.title} ${job.description}`.toLowerCase();
  if (h.includes('part time') || h.includes('part-time')) return 'Part Time';
  if (h.includes('contract')) return 'Contract';
  if (h.includes('intern')) return 'Internship';
  return 'Full Time';
}

export const ALL_CATEGORIES = [...Object.keys(CATEGORY_RULES), 'Other'];

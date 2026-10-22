// Talent: grade bands, job requisitions with approval, careers-portal publishing, CV parsing & matching,
// kanban pipeline support, digital offer letters with e-signature; Performance: OKR cascade, probation
// 30/60/90 reviews, 360 appraisals; Engagement: recognition badges, announcements/townhalls, eNPS surveys.
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { Employee, Establishment, Applicant, User, Notification } from '../../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../../middleware/auth.js';
import { putFile } from '../../lib/storage.js';
import { config } from '../../config.js';
import { GradeBand, JobRequisition, CandidateProfile, Offer, Goal, Review, Recognition, Announcement, Survey, SurveyResponse, ImmigrationCase, AssetRequest } from '../models.js';
import { parseCv, matchScore, validateHire, onboardingSteps } from '../lib/agents.js';
import { respondentHash, scanUpload } from '../lib/platform.js';
import { offerPdf } from '../lib/pdfDocs.js';
import { z, fail, money, ymd, oid, decodeUpload, sendPdf, sealedPdf, publicBase, emitEvent } from './_util.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const HR = requireRole('hr_admin');
const MGR = requireRole('hr_admin', 'manager');
const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function sendEmail(to, subject, text) {
  if (!(process.env.RESEND_API_KEY && process.env.MAIL_FROM) || !to) return false;
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text }), signal: AbortSignal.timeout(15000) }).catch(() => null);
  return !!res?.ok;
}

// =============================================================== Grade bands
r.get('/grade-bands', MGR, ah(async (req, res) => res.json(await GradeBand.find().sort({ minFils: 1 }).lean())));
r.post('/grade-bands', HR, ah(async (req, res) => {
  const b = z.object({ grade: z.string().min(1).max(10), title: z.string().max(60).optional(), min: money, max: money, basicPctMin: z.number().min(0).max(100).default(50) }).parse(req.body);
  if (b.max < b.min) throw fail(400, 'Maximum is below minimum.');
  const g = await GradeBand.findOneAndUpdate({ grade: b.grade }, { $set: { title: b.title, minFils: b.min, maxFils: b.max, basicPctMin: b.basicPctMin } }, { upsert: true, new: true });
  await audit(req, 'grade.upsert', 'GradeBand', g._id, null, b); res.json(g);
}));

// =============================================================== Requisitions
const reqIn = z.object({ title: z.string().min(2).max(100), department: z.string().max(60).optional(), establishmentId: oid.optional(), headcount: z.number().int().min(1).max(100).default(1), grade: z.string().optional(), budgetMin: money.optional(), budgetMax: money.optional(), description: z.string().max(5000).optional(), requirements: z.array(z.string().max(60)).max(30).default([]), location: z.string().max(80).optional(), employmentType: z.string().max(30).default('full-time') });
r.get('/requisitions', MGR, ah(async (req, res) => {
  const reqs = await JobRequisition.find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).lean();
  const counts = await CandidateProfile.aggregate([{ $group: { _id: '$requisitionId', n: { $sum: 1 } } }]);
  res.json(reqs.map((x) => ({ ...x, candidates: counts.find((c) => String(c._id) === String(x._id))?.n || 0 })));
}));
r.post('/requisitions', MGR, ah(async (req, res) => {
  const b = reqIn.parse(req.body);
  const x = await JobRequisition.create({ ...b, budgetMinFils: b.budgetMin, budgetMaxFils: b.budgetMax, status: 'pending_approval', createdBy: req.user.id });
  await Notification.create({ audience: 'hr', title: `Job requisition to approve: ${b.title}`, body: `${b.headcount} × ${b.department || ''}`, link: '#talent' }).catch(() => {});
  await audit(req, 'requisition.create', 'JobRequisition', x._id, null, { title: b.title }); res.status(201).json(x);
}));
r.post('/requisitions/:id/decision', HR, ah(async (req, res) => {
  const { decision, note } = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(300).optional() }).parse(req.body);
  const x = await JobRequisition.findById(req.params.id); if (!x || x.status !== 'pending_approval') throw fail(404, 'Pending requisition not found');
  if (String(x.createdBy) === req.user.id && !req.user.roles.includes('owner')) throw fail(403, 'A different person must approve a requisition they raised.');
  x.approvals.push({ by: req.user.id, decision, note, at: new Date() }); x.status = decision === 'approve' ? 'approved' : 'rejected'; await x.save();
  await audit(req, `requisition.${decision}`, 'JobRequisition', x._id, null, { note }); res.json(x);
}));
r.post('/requisitions/:id/publish', HR, ah(async (req, res) => {
  const { open } = z.object({ open: z.boolean() }).parse(req.body);
  const x = await JobRequisition.findById(req.params.id); if (!x || !['approved', 'open', 'on_hold'].includes(x.status)) throw fail(409, 'Only approved requisitions can be published.');
  x.status = open ? 'open' : 'on_hold'; x.publicSlug ||= `${x.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${randomBytes(3).toString('hex')}`; if (open) x.publishedAt = new Date(); await x.save();
  await audit(req, open ? 'requisition.publish' : 'requisition.unpublish', 'JobRequisition', x._id);
  res.json({ ...x.toObject(), careersUrl: `${publicBase(req)}/api/public/careers/${req.user.tenantId}` });
}));
r.post('/requisitions/:id/close', HR, ah(async (req, res) => { const x = await JobRequisition.findByIdAndUpdate(req.params.id, { $set: { status: 'closed' } }, { new: true }); if (!x) throw fail(404, 'Requisition not found'); await audit(req, 'requisition.close', 'JobRequisition', x._id); res.json(x); }));

// =============================================================== Candidates (CV parsing & matching)
r.post('/applicants/:id/cv', MGR, ah(async (req, res) => {
  const b = z.object({ file: z.string().optional(), contentType: z.string().optional(), fileName: z.string().max(120).optional(), text: z.string().max(60000).optional(), requisitionId: oid.optional() }).parse(req.body);
  const ap = await Applicant.findById(req.params.id).lean(); if (!ap) throw fail(404, 'Applicant not found');
  let cv; let buffer; let type;
  if (b.file) { buffer = decodeUpload(b.file); const s = await scanUpload(buffer, b.contentType); if (!s.ok) throw fail(400, s.error); type = s.type; cv = { ...(await putFile({ tenantId: req.user.tenantId, buffer, declaredType: s.type })), fileName: b.fileName }; }
  const parsed = await parseCv({ buffer, contentType: type, text: b.text });
  const rq = b.requisitionId ? await JobRequisition.findById(b.requisitionId).lean() : null;
  const match = rq ? matchScore(parsed, rq) : undefined;
  const p = await CandidateProfile.findOneAndUpdate({ applicantId: ap._id }, { $set: { ...(cv ? { cv } : {}), parsed, ...(rq ? { requisitionId: rq._id, match } : {}) } }, { upsert: true, new: true });
  await audit(req, 'applicant.cv.parse', 'Applicant', ap._id, null, { engine: parsed.engine, score: match?.score }); res.json(p);
}));
r.get('/requisitions/:id/pipeline', MGR, ah(async (req, res) => {
  const profiles = await CandidateProfile.find({ requisitionId: req.params.id }).lean();
  const aps = await Applicant.find({ _id: { $in: profiles.map((p) => p.applicantId) } }).lean();
  const stages = ['applied', 'screening', 'interviewed', 'offer', 'hired', 'rejected'];
  res.json(Object.fromEntries(stages.map((s) => [s, aps.filter((a) => a.stage === s).map((a) => ({ ...a, profile: profiles.find((p) => String(p.applicantId) === String(a._id)) })).sort((x, y) => (y.profile?.match?.score || 0) - (x.profile?.match?.score || 0))])));
}));
r.post('/applicants/:id/interviews', MGR, ah(async (req, res) => {
  const b = z.object({ at: z.string(), with: z.string().max(80), mode: z.enum(['onsite', 'video', 'phone']).default('video'), feedback: z.string().max(1000).optional(), rating: z.number().min(0).max(5).optional() }).parse(req.body);
  const p = await CandidateProfile.findOneAndUpdate({ applicantId: req.params.id }, { $push: { interviews: { ...b, at: new Date(b.at) } } }, { upsert: true, new: true });
  await audit(req, 'applicant.interview', 'Applicant', req.params.id, null, { at: b.at, mode: b.mode }); res.json(p);
}));

// =============================================================== Offers & e-signature
const offerIn = z.object({ applicantId: oid.optional(), requisitionId: oid.optional(), candidateName: z.string().min(2), candidateEmail: z.string().email().optional(), jobTitle: z.string().min(2), grade: z.string().optional(), establishmentId: oid, startDate: ymd, basic: money, housing: money.default(0), transport: money.default(0), other: money.default(0), probationMonths: z.number().int().min(0).max(6).default(6), noticeDays: z.number().int().min(0).max(90).default(30), visaType: z.string().max(80).optional(), lang: z.enum(['en', 'ar', 'dual']).default('dual') });
export async function createOffer(req, b, source = 'manual') {
  const est = await Establishment.findById(b.establishmentId).lean(); if (!est) throw fail(404, 'Establishment not found');
  const total = b.basic + b.housing + b.transport + b.other;
  const v = validateHire({ candidateName: b.candidateName, jobTitle: b.jobTitle, startDate: b.startDate, totalPackageAed: total / 100, grade: b.grade, split: { basicPct: (b.basic / total) * 100, housingPct: (b.housing / total) * 100, transportPct: ((b.transport + b.other) / total) * 100 } }, { gradeBands: await GradeBand.find().lean(), establishment: est });
  return Offer.create({ ...b, basicFils: b.basic, housingFils: b.housing, transportFils: b.transport, otherFils: b.other, validation: { issues: v.issues.filter((i) => !/split adds up/.test(i)), warnings: v.warnings }, createdBy: req.user.id, source });
}
r.get('/offers', MGR, ah(async (req, res) => res.json(await Offer.find().sort({ createdAt: -1 }).limit(200).lean())));
r.post('/offers', HR, ah(async (req, res) => { const o = await createOffer(req, offerIn.parse(req.body)); await audit(req, 'offer.create', 'Offer', o._id, null, { candidate: o.candidateName, totalFils: o.basicFils + o.housingFils + o.transportFils + o.otherFils }); res.status(201).json(o); }));
r.get('/offers/:id/pdf', MGR, ah(async (req, res) => {
  const o = await Offer.findById(req.params.id).lean(); if (!o) throw fail(404, 'Offer not found'); const est = await Establishment.findById(o.establishmentId).lean();
  sendPdf(res, await sealedPdf(req, { kind: 'offer', title: `Offer ${o.candidateName}` }, (s) => offerPdf({ offer: o, establishment: est, seal: s, signature: o.signature })), `offer-${o.candidateName}.pdf`);
}));
export async function sendOffer(req, offer) {
  if (offer.validation?.issues?.length) throw fail(409, `Fix before sending: ${offer.validation.issues.join(' ')}`);
  const token = randomBytes(24).toString('base64url');
  offer.signTokenHash = sha(token); offer.status = 'sent'; offer.expiresAt = new Date(Date.now() + 7 * 864e5); await offer.save();
  const link = `${publicBase(req)}/api/public/offers/${req.user.tenantId}/${token}`;
  const emailed = await sendEmail(offer.candidateEmail, `Your offer from ${(await Establishment.findById(offer.establishmentId).select('name').lean())?.name}`, `Dear ${offer.candidateName},\n\nPlease review and sign your offer here (valid 7 days):\n${link}\n\nYou can also upload your passport, photo and certificates on the same page.`);
  return { link, emailed };
}
r.post('/offers/:id/send', HR, ah(async (req, res) => {
  const o = await Offer.findById(req.params.id); if (!o || !['draft', 'expired'].includes(o.status)) throw fail(409, 'Only draft or expired offers can be sent.');
  const s = await sendOffer(req, o); await audit(req, 'offer.send', 'Offer', o._id, null, { emailed: s.emailed });
  res.json({ ...s, note: s.emailed ? 'Sent by email.' : 'Email is not configured; copy the link and share it with the candidate.' });
}));
r.post('/offers/:id/withdraw', HR, ah(async (req, res) => { const o = await Offer.findByIdAndUpdate(req.params.id, { $set: { status: 'withdrawn', signTokenHash: null } }, { new: true }); if (!o) throw fail(404, 'Offer not found'); await audit(req, 'offer.withdraw', 'Offer', o._id); res.json(o); }));
/** After signature: create the employee record (onboarding), the visa tracker, IT asset requests and probation check-ins. */
r.post('/offers/:id/convert', HR, ah(async (req, res) => {
  const o = await Offer.findById(req.params.id); if (!o || o.status !== 'signed') throw fail(409, 'The offer must be signed first.');
  if (o.employeeId) throw fail(409, 'Already converted.');
  const est = await Establishment.findById(o.establishmentId).lean();
  const prefix = (est.name.match(/\b[A-Z]/g) || ['E']).join('').slice(0, 3); let n = await Employee.countDocuments(); let employeeNo;
  do { n += 1; employeeNo = `${prefix}-${String(n).padStart(3, '0')}`; } while (await Employee.exists({ employeeNo }));
  const e = await Employee.create({ establishmentId: est._id, employeeNo, fullName: o.candidateName, email: o.candidateEmail, jobTitle: o.jobTitle, joinDate: o.startDate, probationEndDate: new Date(new Date(o.startDate).setMonth(new Date(o.startDate).getMonth() + o.probationMonths)), status: 'onboarding', isUaeNational: /national/i.test(o.visaType || ''), compensation: { basicFils: o.basicFils, housingFils: o.housingFils, transportFils: o.transportFils, allowances: o.otherFils ? [{ code: 'OTHER', label: 'Other allowance', amountFils: o.otherFils }] : [], effectiveFrom: o.startDate } });
  const start = new Date(o.startDate).toISOString().slice(0, 10);
  const existingCase = await ImmigrationCase.findOne({ offerId: o._id, status: { $ne: 'cancelled' } });
  if (existingCase) { existingCase.employeeId = e._id; existingCase.steps.forEach((s) => { if (s.key === 'offer_signed') { s.status = 'done'; s.doneAt = o.signature.at; } }); await existingCase.save(); }
  const vc = existingCase || await ImmigrationCase.create({ employeeId: e._id, offerId: o._id, subjectName: e.fullName, establishmentId: est._id, kind: 'new_hire', jurisdiction: est.jurisdiction, steps: onboardingSteps({ startDate: start, jurisdiction: est.jurisdiction, visa: /national/i.test(o.visaType || '') ? 'uae_national' : est.jurisdiction === 'FREEZONE' ? 'freezone' : 'mainland' }).map((s) => (s.key === 'offer_signed' ? { ...s, status: 'done', doneAt: o.signature.at } : s)), createdBy: req.user.id, source: 'offer' });
  await AssetRequest.insertMany(['laptop', 'email_account', 'access_card'].map((kind) => ({ employeeId: e._id, kind, reason: `New joiner ${e.fullName}`, neededBy: o.startDate, source: 'offer' })));
  const reviews = await scheduleProbation(e);
  o.employeeId = e._id; await o.save();
  if (o.applicantId) await Applicant.updateOne({ _id: o.applicantId }, { $set: { stage: 'hired', movedAt: new Date() } });
  await audit(req, 'offer.convert', 'Offer', o._id, null, { employeeId: e._id, visaCaseId: vc._id, reviews: reviews.length });
  await emitEvent('employee.onboarding', { employeeId: String(e._id), offerId: String(o._id), startDate: start });
  res.json({ employee: e, visaCase: vc, reviews });
}));

// =============================================================== Performance
export async function scheduleProbation(e) {
  const j = new Date(e.joinDate); const at = (d) => new Date(j.getTime() + d * 864e5);
  const mgr = e.managerId ? await User.findOne({ employeeId: e.managerId }).select('_id').lean() : null;
  const reviewers = [{ employeeId: e._id, relation: 'self' }, ...(mgr ? [{ userId: mgr._id, employeeId: e.managerId, relation: 'manager' }] : [{ relation: 'hr' }])];
  const out = [];
  for (const [kind, d] of [['probation_30', 30], ['probation_60', 60], ['probation_90', 90]]) {
    if (await Review.exists({ employeeId: e._id, kind })) continue;
    out.push(await Review.create({ employeeId: e._id, kind, cycle: 'probation', dueDate: at(d), reviewers }));
  }
  return out;
}
r.post('/reviews/probation/:employeeId', MGR, ah(async (req, res) => { const e = await Employee.findById(req.params.employeeId).lean(); if (!e) throw fail(404, 'Employee not found'); const rv = await scheduleProbation(e); await audit(req, 'review.probation.schedule', 'Employee', e._id, null, { created: rv.length }); res.json(rv); }));
r.post('/reviews/360', MGR, ah(async (req, res) => {
  const b = z.object({ employeeId: oid, cycle: z.string().min(2).max(20), dueDate: ymd, peerIds: z.array(oid).max(8).default([]), reportIds: z.array(oid).max(8).default([]), competencies: z.array(z.string().max(40)).min(3).max(8).optional() }).parse(req.body);
  const e = await Employee.findById(b.employeeId).lean(); if (!e) throw fail(404, 'Employee not found');
  const reviewers = [{ employeeId: e._id, relation: 'self' }, ...(e.managerId ? [{ employeeId: e.managerId, relation: 'manager' }] : []), ...b.peerIds.map((id) => ({ employeeId: id, relation: 'peer' })), ...b.reportIds.map((id) => ({ employeeId: id, relation: 'report' }))].map((x) => ({ ...x, invitedAt: new Date() }));
  const rv = await Review.create({ employeeId: e._id, kind: '360', cycle: b.cycle, dueDate: b.dueDate, reviewers, ...(b.competencies ? { competencies: b.competencies } : {}), status: 'in_progress' });
  for (const x of reviewers) if (x.relation !== 'self') await Notification.create({ audience: 'employee', employeeId: x.employeeId, title: `Feedback requested for ${e.fullName}`, body: `Due ${b.dueDate}`, link: '#eperf' }).catch(() => {});
  await audit(req, 'review.360.create', 'Review', rv._id, null, { reviewers: reviewers.length }); res.status(201).json(rv);
}));
const anonymise = (rv) => ({ ...rv, reviewers: rv.reviewers.map((x) => (['peer', 'report'].includes(x.relation) ? { relation: x.relation, ratings: x.ratings, strengths: x.strengths, improvements: x.improvements, submittedAt: x.submittedAt } : x)) });
r.get('/reviews', MGR, ah(async (req, res) => {
  const q = { ...(req.query.employeeId ? { employeeId: req.query.employeeId } : {}), ...(req.query.status ? { status: req.query.status } : { status: { $ne: 'cancelled' } }) };
  const rows = await Review.find(q).sort({ dueDate: 1 }).limit(300).populate('employeeId', 'fullName employeeNo department').lean();
  res.json(rows.map((rv) => { const a = anonymise(rv); const sub = rv.reviewers.filter((x) => x.submittedAt); const avg = sub.length ? Math.round((sub.flatMap((x) => x.ratings || []).reduce((s, v) => s + v, 0) / Math.max(1, sub.flatMap((x) => x.ratings || []).length)) * 10) / 10 : null; return { ...a, submitted: sub.length, avgRating: avg }; }));
}));
r.post('/reviews/:id/outcome', MGR, ah(async (req, res) => {
  const b = z.object({ rating: z.number().min(1).max(5), recommendation: z.enum(['confirm', 'extend', 'terminate', 'promote', 'pip', 'none']), note: z.string().max(1000).optional() }).parse(req.body);
  const rv = await Review.findById(req.params.id); if (!rv) throw fail(404, 'Review not found');
  rv.outcome = { ...b, decidedBy: req.user.id, decidedAt: new Date() }; rv.status = 'completed'; await rv.save();
  await audit(req, 'review.outcome', 'Review', rv._id, null, b); res.json(rv);
}));
r.get('/me/reviews', ah(async (req, res) => {
  const mine = await Review.find({ 'reviewers.employeeId': req.user.employeeId, status: { $in: ['scheduled', 'in_progress'] } }).populate('employeeId', 'fullName jobTitle').lean();
  res.json(mine.map((rv) => ({ _id: rv._id, kind: rv.kind, cycle: rv.cycle, dueDate: rv.dueDate, subject: rv.employeeId, competencies: rv.competencies, myRelation: rv.reviewers.find((x) => String(x.employeeId) === String(req.user.employeeId))?.relation, submitted: !!rv.reviewers.find((x) => String(x.employeeId) === String(req.user.employeeId))?.submittedAt })));
}));
r.post('/me/reviews/:id', ah(async (req, res) => {
  const b = z.object({ ratings: z.array(z.number().int().min(1).max(5)).min(1).max(8), strengths: z.string().max(1500).optional(), improvements: z.string().max(1500).optional() }).parse(req.body);
  const rv = await Review.findById(req.params.id); if (!rv) throw fail(404, 'Review not found');
  const me = rv.reviewers.find((x) => String(x.employeeId) === String(req.user.employeeId)); if (!me) throw fail(403, 'You are not a reviewer on this review.');
  if (me.submittedAt) throw fail(409, 'You already submitted this feedback.');
  if (b.ratings.length !== rv.competencies.length) throw fail(400, `Rate all ${rv.competencies.length} competencies.`);
  Object.assign(me, b, { submittedAt: new Date() }); if (rv.status === 'scheduled') rv.status = 'in_progress'; await rv.save();
  await audit(req, 'review.submit', 'Review', rv._id, null, { relation: me.relation }); res.json({ ok: true });
}));

// OKRs
const goalIn = z.object({ ownerType: z.enum(['company', 'department', 'employee']).default('employee'), employeeId: oid.optional(), department: z.string().optional(), parentId: oid.optional(), title: z.string().min(3).max(160), description: z.string().max(1000).optional(), cycle: z.string().min(4).max(10), keyResults: z.array(z.object({ title: z.string().min(2).max(160), metric: z.string().max(30).optional(), start: z.number().default(0), target: z.number(), current: z.number().default(0), weight: z.number().min(0).max(10).default(1) })).max(6).default([]) });
const progress = (g) => { const k = g.keyResults || []; const w = k.reduce((a, x) => a + (x.weight || 1), 0); return w ? Math.round((k.reduce((a, x) => a + (x.weight || 1) * Math.max(0, Math.min(1, (x.current - x.start) / ((x.target - x.start) || 1))), 0) / w) * 100) : 0; };
r.get('/goals', MGR, ah(async (req, res) => {
  const goals = (await Goal.find({ cycle: req.query.cycle || { $exists: true } }).populate('employeeId', 'fullName department').lean()).map((g) => ({ ...g, progress: progress(g) }));
  const byParent = {}; goals.forEach((g) => (byParent[String(g.parentId || 'root')] ||= []).push(g));
  const tree = (id) => (byParent[id] || []).map((g) => ({ ...g, children: tree(String(g._id)) }));
  res.json({ goals, tree: tree('root') });
}));
r.post('/goals', MGR, ah(async (req, res) => { const b = goalIn.parse(req.body); if (b.parentId && !(await Goal.exists({ _id: b.parentId }))) throw fail(404, 'Parent goal not found'); const g = await Goal.create({ ...b, createdBy: req.user.id }); await audit(req, 'goal.create', 'Goal', g._id, null, { title: b.title }); res.status(201).json(g); }));
r.patch('/goals/:id', MGR, ah(async (req, res) => { const b = goalIn.partial().extend({ status: z.enum(['draft', 'active', 'at_risk', 'done', 'dropped']).optional() }).parse(req.body); const g = await Goal.findByIdAndUpdate(req.params.id, { $set: b }, { new: true }); if (!g) throw fail(404, 'Goal not found'); await audit(req, 'goal.update', 'Goal', g._id, null, b); res.json(g); }));
r.get('/me/goals', ah(async (req, res) => res.json((await Goal.find({ employeeId: req.user.employeeId }).lean()).map((g) => ({ ...g, progress: progress(g) })))));
r.patch('/me/goals/:id/kr/:index', ah(async (req, res) => {
  const { current } = z.object({ current: z.number() }).parse(req.body);
  const g = await Goal.findOne({ _id: req.params.id, employeeId: req.user.employeeId }); if (!g) throw fail(404, 'Goal not found');
  const kr = g.keyResults[Number(req.params.index)]; if (!kr) throw fail(404, 'Key result not found');
  kr.current = current; await g.save(); res.json({ ...g.toObject(), progress: progress(g) });
}));

// =============================================================== Engagement
r.post('/me/recognition', ah(async (req, res) => {
  const b = z.object({ toEmployeeId: oid, badge: z.enum(['team_player', 'customer_hero', 'innovator', 'above_and_beyond', 'mentor', 'safety_star']), message: z.string().min(3).max(400), visibility: z.enum(['public', 'private']).default('public') }).parse(req.body);
  if (b.toEmployeeId === String(req.user.employeeId)) throw fail(400, 'Recognise a colleague, not yourself.');
  if (!(await Employee.exists({ _id: b.toEmployeeId, status: { $ne: 'exited' } }))) throw fail(404, 'Colleague not found');
  const x = await Recognition.create({ ...b, fromEmployeeId: req.user.employeeId, fromUserId: req.user.id });
  await Notification.create({ audience: 'employee', employeeId: b.toEmployeeId, title: `You received a ${b.badge.replace(/_/g, ' ')} badge`, body: b.message.slice(0, 120), link: '#eengage' }).catch(() => {});
  res.status(201).json(x);
}));
r.get('/me/colleagues', ah(async (req, res) => res.json(await Employee.find({ status: { $in: ['active', 'notice'] }, _id: { $ne: req.user.employeeId } }).select('fullName jobTitle department').sort({ fullName: 1 }).lean())));
const feed = async () => {
  const [rec, ann] = await Promise.all([Recognition.find({ visibility: 'public' }).sort({ createdAt: -1 }).limit(30).populate('toEmployeeId', 'fullName department').populate('fromEmployeeId', 'fullName').lean(), Announcement.find({ publishedAt: { $ne: null } }).sort({ pinned: -1, publishedAt: -1 }).limit(20).lean()]);
  return { recognition: rec, announcements: ann };
};
r.get('/me/feed', ah(async (req, res) => res.json(await feed())));
r.get('/engagement/feed', MGR, ah(async (req, res) => res.json(await feed())));
r.post('/announcements', HR, ah(async (req, res) => {
  const b = z.object({ title: z.string().min(3).max(140), titleAr: z.string().max(140).optional(), body: z.string().max(5000).optional(), bodyAr: z.string().max(5000).optional(), kind: z.enum(['news', 'townhall', 'policy', 'event']).default('news'), eventAt: z.string().optional(), link: z.string().url().optional(), pinned: z.boolean().default(false) }).parse(req.body);
  const a = await Announcement.create({ ...b, eventAt: b.eventAt ? new Date(b.eventAt) : undefined, publishedBy: req.user.id, publishedAt: new Date() });
  await audit(req, 'announcement.publish', 'Announcement', a._id, null, { title: b.title, kind: b.kind }); res.status(201).json(a);
}));
r.post('/me/announcements/:id/read', ah(async (req, res) => { await Announcement.updateOne({ _id: req.params.id }, { $addToSet: { readBy: req.user.id } }); res.json({ ok: true }); }));

// eNPS / pulse surveys (anonymous; results only above a minimum group size)
r.get('/surveys', MGR, ah(async (req, res) => res.json(await Survey.find().sort({ createdAt: -1 }).lean())));
r.post('/surveys', HR, ah(async (req, res) => {
  const b = z.object({ title: z.string().min(3).max(120), kind: z.enum(['enps', 'pulse', 'custom']).default('enps'), questions: z.array(z.object({ text: z.string().min(3).max(200), type: z.enum(['scale10', 'scale5', 'text']) })).max(10).optional(), closesAt: ymd.optional(), minGroupSize: z.number().int().min(3).max(20).default(5) }).parse(req.body);
  const questions = (b.questions?.length ? b.questions : [{ text: 'How likely are you to recommend working here to a friend? (0–10)', type: 'scale10' }, { text: 'What is one thing we should improve?', type: 'text' }]).map((q, i) => ({ ...q, id: `q${i + 1}` }));
  const s = await Survey.create({ ...b, questions, status: 'open', opensAt: new Date(), closesAt: b.closesAt ? new Date(`${b.closesAt}T23:59:59Z`) : undefined });
  await audit(req, 'survey.create', 'Survey', s._id, null, { title: b.title }); res.status(201).json(s);
}));
r.get('/me/surveys', ah(async (req, res) => {
  const open = await Survey.find({ status: 'open', $or: [{ closesAt: null }, { closesAt: { $gte: new Date() } }] }).lean();
  const done = await SurveyResponse.find({ surveyId: { $in: open.map((s) => s._id) }, respondentHash: { $in: open.map((s) => respondentHash(config.jwtSecret, String(s._id), String(req.user.employeeId))) } }).select('surveyId').lean();
  res.json(open.map((s) => ({ ...s, answered: done.some((d) => String(d.surveyId) === String(s._id)) })));
}));
r.post('/me/surveys/:id', ah(async (req, res) => {
  const s = await Survey.findById(req.params.id).lean(); if (!s || s.status !== 'open') throw fail(404, 'Survey is not open');
  const answers = z.record(z.union([z.number(), z.string().max(1000)])).parse(req.body.answers || {});
  for (const q of s.questions) { const v = answers[q.id]; if (v == null) continue; if (q.type === 'scale10' && !(Number.isInteger(v) && v >= 0 && v <= 10)) throw fail(400, 'Scores are 0–10.'); if (q.type === 'scale5' && !(Number.isInteger(v) && v >= 1 && v <= 5)) throw fail(400, 'Scores are 1–5.'); }
  const emp = await Employee.findById(req.user.employeeId).select('department').lean();
  try { await SurveyResponse.create({ surveyId: s._id, respondentHash: respondentHash(config.jwtSecret, String(s._id), String(req.user.employeeId)), department: emp?.department, answers }); } catch (e) { if (e?.code === 11000) throw fail(409, 'You already answered this survey.'); throw e; }
  res.status(201).json({ ok: true });
}));
export function enps(scores) { if (!scores.length) return null; const p = scores.filter((x) => x >= 9).length, d = scores.filter((x) => x <= 6).length; return Math.round(((p - d) / scores.length) * 100); }
r.get('/surveys/:id/results', MGR, ah(async (req, res) => {
  const s = await Survey.findById(req.params.id).lean(); if (!s) throw fail(404, 'Survey not found');
  const rs = await SurveyResponse.find({ surveyId: s._id }).lean();
  if (rs.length < s.minGroupSize) return res.json({ responses: rs.length, suppressed: true, note: `Results appear once ${s.minGroupSize} people have answered.` });
  const q10 = s.questions.find((q) => q.type === 'scale10');
  const byDept = {}; rs.forEach((x) => (byDept[x.department || 'Unassigned'] ||= []).push(x));
  res.json({
    responses: rs.length, enps: q10 ? enps(rs.map((x) => x.answers?.[q10.id]).filter((v) => v != null)) : null,
    departments: Object.entries(byDept).map(([d, a]) => (a.length < s.minGroupSize ? { department: d, responses: a.length, suppressed: true } : { department: d, responses: a.length, enps: q10 ? enps(a.map((x) => x.answers?.[q10.id]).filter((v) => v != null)) : null })),
    comments: s.questions.filter((q) => q.type === 'text').flatMap((q) => rs.map((x) => x.answers?.[q.id]).filter(Boolean)).sort(() => Math.random() - 0.5).slice(0, 50),
  });
}));
r.post('/surveys/:id/close', HR, ah(async (req, res) => { const s = await Survey.findByIdAndUpdate(req.params.id, { $set: { status: 'closed', closesAt: new Date() } }, { new: true }); if (!s) throw fail(404, 'Survey not found'); await audit(req, 'survey.close', 'Survey', s._id); res.json(s); }));

export default r;

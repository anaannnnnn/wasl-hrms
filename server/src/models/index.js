import mongoose from 'mongoose';
import { tenantPlugin } from '../lib/tenantContext.js';

const { Schema, model } = mongoose;
const Id = Schema.Types.ObjectId;
const fils = { type: Number, default: 0, validate: { validator: Number.isInteger, message: 'Money must be integer fils' } };

// ---------- Tenant (platform-level, not tenant-scoped) ----------
export const Tenant = model('Tenant', new Schema({
  name: { type: String, required: true },
  plan: { type: String, enum: ['starter', 'growth', 'enterprise'], default: 'starter' },
  defaultLanguage: { type: String, enum: ['en', 'ar'], default: 'en' },
  settings: { payrollCutoffDay: { type: Number, default: 25 }, gratuityDailyDivisor: { type: Number, default: 365 } },
}, { timestamps: true }));

// ---------- Users ----------
const userSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  name: String,
  passwordHash: { type: String, required: true, select: false },
  roles: [{ type: String, enum: ['owner', 'hr_admin', 'payroll_maker', 'payroll_checker', 'manager', 'employee'] }],
  employeeId: { type: Id, ref: 'Employee' },
  establishmentIds: [{ type: Id, ref: 'Establishment' }],
  active: { type: Boolean, default: true },
}, { timestamps: true });
userSchema.plugin(tenantPlugin);
userSchema.index({ email: 1 }, { unique: true }); // email unique across platform for login
export const User = model('User', userSchema);

// ---------- Establishments (trade licences / establishment cards) ----------
const estSchema = new Schema({
  name: { type: String, required: true },
  nameAr: String,
  jurisdiction: { type: String, enum: ['MAINLAND', 'FREEZONE'], required: true },
  freeZone: { type: String, enum: [null, 'DIFC', 'ADGM', 'DMCC', 'JAFZA', 'DAFZA', 'SHAMS', 'OTHER'], default: null },
  rulePackId: { type: String, default: 'UAE-MAINLAND' },
  emirate: String,
  mohreId: { type: String, match: /^\d{13}$/ },
  tradeLicenceNo: String,
  tradeLicenceExpiry: Date,
  establishmentCardExpiry: Date,
  designatedSector: { type: Boolean, default: false },
  wps: { agentName: String, agentRoutingCode: { type: String, match: /^\d{9}$/ } },
}, { timestamps: true });
estSchema.plugin(tenantPlugin);
estSchema.index({ tenantId: 1, mohreId: 1 }, { unique: true, sparse: true });
export const Establishment = model('Establishment', estSchema);

// ---------- Employees ----------
const empSchema = new Schema({
  establishmentId: { type: Id, ref: 'Establishment', required: true },
  employeeNo: { type: String, required: true },
  fullName: { type: String, required: true },
  fullNameAr: String,
  email: String,
  phone: String,
  nationality: String,
  isUaeNational: { type: Boolean, default: false },
  gender: { type: String, enum: ['M', 'F', null], default: null },
  dateOfBirth: Date,
  jobTitle: String,
  department: String,
  managerId: { type: Id, ref: 'Employee' },
  mohreSkillLevel: { type: Number, min: 1, max: 9 },
  contractType: { type: String, enum: ['full-time', 'part-time', 'temporary', 'flexible'], default: 'full-time' },
  joinDate: { type: Date, required: true },
  probationEndDate: Date,
  status: { type: String, enum: ['onboarding', 'active', 'notice', 'exited'], default: 'active' },
  exitDate: Date,
  pensionRegistered: { type: Boolean, default: false },
  paidViaWps: { type: Boolean, default: true },
  compensation: {
    basicFils: fils, housingFils: fils, transportFils: fils,
    allowances: [{ code: String, label: String, amountFils: fils }],
    effectiveFrom: Date,
  },
  compensationHistory: [{ effectiveFrom: Date, basicFils: Number, housingFils: Number, transportFils: Number, changedBy: Id }],
  bank: {
    iban: { type: String, select: false },
    routingCode: { type: String, select: false },
    bankName: String,
    ibanLast4: String,
  },
  labourCardNo: { type: String, select: false },
  emiratesIdLast4: String,
  dependents: [{ name: String, relation: String, dateOfBirth: Date }],
  emergencyContacts: [{ name: String, relation: String, phone: String }],
  custom: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });
empSchema.plugin(tenantPlugin);
empSchema.index({ tenantId: 1, employeeNo: 1 }, { unique: true });
empSchema.index({ tenantId: 1, establishmentId: 1, status: 1 });
empSchema.pre('save', function () { if (this.bank?.iban) this.bank.ibanLast4 = this.bank.iban.slice(-4); });
export const Employee = model('Employee', empSchema);

// ---------- Compliance documents ----------
const docSchema = new Schema({
  ownerType: { type: String, enum: ['employee', 'establishment'], required: true },
  employeeId: { type: Id, ref: 'Employee' },
  establishmentId: { type: Id, ref: 'Establishment' },
  docType: { type: String, enum: ['passport', 'residence_visa', 'emirates_id', 'labour_card', 'driving_licence', 'health_insurance', 'trade_licence', 'establishment_card'], required: true },
  number: { type: String, select: false },
  issueDate: Date,
  expiryDate: { type: Date, required: true },
  storageKey: String, // Linode Object Storage key; served via short-lived presigned URL
  ocr: { type: Schema.Types.Mixed },
  alertsSent: [{ daysBefore: Number, sentAt: Date }],
  renewalCase: { status: { type: String, enum: ['none', 'open', 'in_progress', 'done'], default: 'none' }, ownerUserId: Id, steps: [{ name: String, done: Boolean, at: Date }] },
}, { timestamps: true });
docSchema.plugin(tenantPlugin);
docSchema.index({ tenantId: 1, expiryDate: 1 });
export const ComplianceDocument = model('ComplianceDocument', docSchema);

// ---------- Leave ----------
const leaveSchema = new Schema({
  employeeId: { type: Id, ref: 'Employee', required: true },
  type: { type: String, enum: ['annual', 'sick', 'maternity', 'parental', 'hajj', 'unpaid', 'other'], required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  days: { type: Number, required: true },
  reason: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  decidedBy: { type: Id, ref: 'User' },
  decidedAt: Date,
  source: { type: String, enum: ['web', 'mobile', 'whatsapp', 'agent'], default: 'web' },
}, { timestamps: true });
leaveSchema.plugin(tenantPlugin);
leaveSchema.index({ tenantId: 1, employeeId: 1, startDate: 1 });
export const LeaveRequest = model('LeaveRequest', leaveSchema);

// ---------- Payroll ----------
const runSchema = new Schema({
  establishmentId: { type: Id, ref: 'Establishment', required: true },
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  status: { type: String, enum: ['draft', 'preflight_failed', 'pending_approval', 'approved', 'exported', 'paid'], default: 'draft' },
  lines: [{
    employeeId: Id, employeeName: String, fixedFils: Number, variableFils: Number, grossFils: Number,
    deductionsFils: Number, netFils: Number, unpaidLeaveDays: Number,
    flags: [{ code: String, severity: String, msg: String }], held: Boolean,
  }],
  totals: { grossFils: Number, netFils: Number, heldFils: Number },
  rulePack: String,
  inputsHash: String,
  makerId: { type: Id, ref: 'User' },
  checkerId: { type: Id, ref: 'User' },
  approvedAt: Date,
  locked: { type: Boolean, default: false },
}, { timestamps: true });
runSchema.plugin(tenantPlugin);
runSchema.index({ tenantId: 1, establishmentId: 1, period: 1 }, { unique: true });
export const PayrollRun = model('PayrollRun', runSchema);

const payInputSchema = new Schema({
  employeeId: { type: Id, ref: 'Employee', required: true },
  period: { type: String, required: true },
  overtimeFils: fils, commissionFils: fils, expenseReimbursementFils: fils,
  loanInstallmentFils: fils, fineFils: fils, unpaidLeaveDays: { type: Number, default: 0 },
});
payInputSchema.plugin(tenantPlugin);
payInputSchema.index({ tenantId: 1, employeeId: 1, period: 1 }, { unique: true });
export const PayrollInput = model('PayrollInput', payInputSchema);

const sifSchema = new Schema({
  payrollRunId: { type: Id, ref: 'PayrollRun', required: true },
  filename: String,
  content: String,
  checks: [{ id: String, status: String, label: String, detail: String }],
  totalFils: Number,
  recordCount: Number,
  status: { type: String, enum: ['generated', 'submitted', 'accepted', 'rejected'], default: 'generated' },
  generatedBy: Id,
}, { timestamps: true });
sifSchema.plugin(tenantPlugin);
export const WpsSifBatch = model('WpsSifBatch', sifSchema);

// ---------- AI agent runs & audit ----------
const agentSchema = new Schema({
  userId: Id, command: String, intent: String,
  proposal: Schema.Types.Mixed,
  status: { type: String, enum: ['proposed', 'approved', 'executed', 'discarded', 'failed'], default: 'proposed' },
  result: Schema.Types.Mixed,
}, { timestamps: true });
agentSchema.plugin(tenantPlugin);
export const AgentRun = model('AgentRun', agentSchema);

const auditSchema = new Schema({
  actorId: Id, actorType: { type: String, enum: ['user', 'agent', 'system'], default: 'user' },
  action: String, entity: String, entityId: String,
  before: Schema.Types.Mixed, after: Schema.Types.Mixed,
  ip: String, correlationId: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
auditSchema.plugin(tenantPlugin);
auditSchema.index({ tenantId: 1, createdAt: -1 });
// append-only
auditSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'], function () { throw new Error('Audit log is immutable'); });
export const AuditLog = model('AuditLog', auditSchema);

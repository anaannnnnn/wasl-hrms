// PDPL retention: decide what a retention run should do. Pure and unit-tested; the scheduler applies it.
const DAY = 86400000;

export const DEFAULT_RETENTION = { notificationsDays: 180, agentRunsDays: 365, exitedEmployeeYears: 5, sifFilesYears: 5 };

export function retentionCutoffs(retention = {}, now = new Date()) {
  const r = { ...DEFAULT_RETENTION, ...retention };
  return {
    notificationsBefore: new Date(now.getTime() - r.notificationsDays * DAY),
    agentRunsBefore: new Date(now.getTime() - r.agentRunsDays * DAY),
    exitedBefore: new Date(now.getTime() - r.exitedEmployeeYears * 365 * DAY),
    sifBefore: new Date(now.getTime() - r.sifFilesYears * 365 * DAY),
  };
}

/** Personal fields cleared when an exited employee passes the retention period. Payroll amounts are kept. */
export function anonymisedFields(employee) {
  return {
    fullName: `Former employee ${employee.employeeNo}`, fullNameAr: null, email: null, phone: null, dateOfBirth: null,
    emiratesIdLast4: null, dependents: [], emergencyContacts: [], 'bank.iban': null, 'bank.ibanLast4': null, labourCardNo: null,
    custom: {}, anonymisedAt: new Date(),
  };
}

export const shouldAnonymise = (e, cutoff) => e.status === 'exited' && !e.legalHold && !e.anonymisedAt && e.exitDate && new Date(e.exitDate) < cutoff;

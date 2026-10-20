// English → Arabic UI dictionary. After each render, translateTree() swaps any text node, placeholder,
// aria-label or title that exactly matches a key. Data values (names, amounts, dates) are never touched.
// Add phrases here as screens grow; untranslated text simply stays in English.
export const AR = {
  // navigation & shell
  'Command Center': 'مركز القيادة', 'Employees': 'الموظفون', 'Payroll & WPS': 'الرواتب ونظام حماية الأجور', 'Emiratisation': 'التوطين',
  'Document Radar': 'رادار الوثائق', 'Gratuity (EOSB)': 'مكافأة نهاية الخدمة', 'Leave': 'الإجازات', 'Audit log': 'سجل التدقيق',
  'Requests': 'الطلبات', 'Setup': 'الإعداد', 'My Workspace': 'مساحتي', 'WORKSPACE': 'مساحة العمل', 'Sign out': 'تسجيل الخروج', 'Collapse': 'طي',
  'POWERED BY': 'بدعم من', 'Run': 'تنفيذ', 'Entity': 'المنشأة', 'All entities': 'كل المنشآت', 'Notifications': 'الإشعارات', 'Mark all read': 'تحديد الكل كمقروء',
  'No notifications yet.': 'لا توجد إشعارات بعد.',
  // common
  'Open': 'فتح', 'Save': 'حفظ', 'Cancel': 'إلغاء', 'Approve': 'اعتماد', 'Reject': 'رفض', 'Submit': 'إرسال', 'Preview': 'معاينة', 'Download': 'تنزيل',
  'View': 'عرض', 'Upload': 'رفع', 'Status': 'الحالة', 'Employee': 'الموظف', 'Team': 'الفريق', 'Role': 'الوظيفة', 'Nationality': 'الجنسية', 'Joined': 'تاريخ الالتحاق',
  'Basic (AED)': 'الأساسي (درهم)', 'IBAN': 'رقم الآيبان', 'Fixed': 'ثابت', 'Variable': 'متغير', 'Net': 'الصافي', 'Holder': 'الحامل', 'Document': 'الوثيقة',
  'Expiry': 'الانتهاء', 'Expires in': 'ينتهي خلال', 'Renewal': 'التجديد', 'Open case': 'فتح ملف', 'Ready': 'جاهز', 'Held': 'محتجز', 'Review': 'مراجعة',
  'Counts': 'محتسب', 'Not counted': 'غير محتسب', 'UAE National': 'مواطن إماراتي', 'Selected': 'المحدد', 'Loading…': 'جارٍ التحميل…',
  'Needs attention': 'بحاجة إلى متابعة', 'Nothing needs attention right now.': 'لا يوجد ما يتطلب المتابعة حالياً.', 'Active employees': 'الموظفون النشطون',
  'Net payroll': 'صافي الرواتب', 'Headcount by team': 'عدد الموظفين حسب الفريق', 'Cost by team': 'التكلفة حسب الفريق', 'Pay mix': 'تركيبة الأجور',
  'WPS pre-flight': 'الفحص المسبق لملف الأجور', 'Re-run checks': 'إعادة الفحص', 'Recompute': 'إعادة الاحتساب', 'Submit for approval': 'إرسال للاعتماد',
  'Approve payroll': 'اعتماد الرواتب', 'Export .SIF': 'تصدير ملف SIF', 'Show all teams': 'عرض كل الفرق', 'Payslips': 'قسائم الرواتب', 'Release payslips': 'إصدار القسائم',
  'Off-cycle payment': 'دفعة خارج الدورة', 'Final settlement': 'التسوية النهائية', 'Create final settlement': 'إنشاء التسوية النهائية',
  'Gratuity payable': 'المكافأة المستحقة', 'Last working day': 'آخر يوم عمل', 'Unpaid leave days': 'أيام الإجازة غير المدفوعة', 'Scheme': 'النظام',
  'Hire vs. pay the fine': 'التوظيف مقابل دفع الغرامة', 'Quota': 'الحصة', 'Fine / year': 'الغرامة / سنة', 'Next 12 weeks': 'الأسابيع الـ12 القادمة',
  'Upload document': 'رفع وثيقة', 'Read with AI': 'قراءة بالذكاء الاصطناعي', 'Document type': 'نوع الوثيقة', 'Expiry date': 'تاريخ الانتهاء', 'Issue date': 'تاريخ الإصدار',
  'Document number': 'رقم الوثيقة', 'File': 'الملف', 'Open renewal case': 'فتح ملف التجديد',
  'Compute': 'الاحتساب', 'Pre-flight & submit': 'الفحص والإرسال', 'Checker approval': 'اعتماد المدقق', 'SIF export': 'تصدير SIF',
  'Click a column to filter the register': 'انقر على عمود لتصفية السجل', 'Export stays locked until pre-flight passes and a different person approves.': 'يبقى التصدير مقفلاً حتى ينجح الفحص ويعتمد شخص آخر.',
  'No blocking errors': 'لا توجد أخطاء مانعة', 'Off-cycle & final settlement runs': 'دفعات خارج الدورة والتسويات النهائية', 'Create off-cycle run': 'إنشاء دفعة خارج الدورة',
  'Title': 'العنوان', 'Amount (AED)': 'المبلغ (درهم)', 'Save document': 'حفظ الوثيقة', 'Request type': 'نوع الطلب', 'Hello,': 'مرحباً،', 'Good day,': 'يوماً سعيداً،',
  // leave
  'Request leave': 'طلب إجازة', 'Leave type': 'نوع الإجازة', 'Start date': 'تاريخ البدء', 'End date': 'تاريخ الانتهاء', 'Reason': 'السبب', 'Balances': 'الأرصدة',
  'Annual': 'سنوية', 'Sick': 'مرضية', 'Maternity': 'أمومة', 'Parental': 'والدية', 'Hajj': 'حج', 'Unpaid': 'غير مدفوعة', 'Pending': 'قيد الانتظار', 'Approved': 'معتمدة', 'Rejected': 'مرفوضة',
  'Annual leave': 'الإجازة السنوية', 'Sick leave': 'الإجازة المرضية', 'remaining': 'متبقية', 'Check policy': 'التحقق من السياسة', "Child's date of birth": 'تاريخ ميلاد الطفل',
  // self-service
  'Overview': 'نظرة عامة', 'My documents': 'وثائقي', 'My requests': 'طلباتي', 'New request': 'طلب جديد', 'Request type': 'نوع الطلب', 'Letter': 'خطاب',
  'Salary certificate': 'شهادة راتب', 'Salary transfer letter': 'خطاب تحويل راتب', 'No objection certificate': 'شهادة عدم ممانعة', 'Experience certificate': 'شهادة خبرة',
  'Addressed to': 'موجه إلى', 'Language': 'اللغة', 'English + Arabic': 'إنجليزي + عربي', 'Bank details change': 'تغيير بيانات البنك', 'Salary query': 'استفسار عن الراتب',
  'Personal data change': 'تحديث البيانات الشخصية', 'IT / facilities': 'تقنية المعلومات / المرافق', 'Other': 'أخرى', 'Details': 'التفاصيل', 'Send request': 'إرسال الطلب',
  'Open letter': 'فتح الخطاب', 'Issue letter': 'إصدار خطاب', 'Mark done': 'تم الإنجاز', 'In progress': 'قيد التنفيذ', 'Request centre': 'مركز الطلبات',
  // setup
  'Go-live checklist': 'قائمة جاهزية الإطلاق', 'Import employees': 'استيراد الموظفين', 'Download template': 'تنزيل النموذج', 'Check file': 'فحص الملف', 'Import': 'استيراد',
  'Rule packs': 'حزم القواعد', 'Settings': 'الإعدادات', 'Gratuity cap basis': 'أساس سقف المكافأة', 'Total remuneration': 'إجمالي الأجر', 'Basic salary': 'الراتب الأساسي',
};

const ATTRS = ['placeholder', 'aria-label', 'title'];
export function translateTree(root, lang) {
  if (lang !== 'ar' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue; const key = raw.trim();
    if (key && AR[key]) n.nodeValue = raw.replace(key, AR[key]);
  }
  root.querySelectorAll('[placeholder],[aria-label],[title]').forEach((el) => ATTRS.forEach((a) => { const v = el.getAttribute(a); if (v && AR[v.trim()]) el.setAttribute(a, AR[v.trim()]); }));
}

import type { Catalogue } from './en';

/**
 * The Arabic catalogue, typed against the English one: a key that English has and Arabic
 * lacks is a compile error, which is the only reliable way to keep two catalogues honest.
 */
export const ar: Catalogue = {
  app: {
    name: 'مناخة للوثائق',
    description: 'ضبط الوثائق المؤسسية',
  },
  state: {
    loading: 'جارٍ التحميل…',
    empty: 'لا يوجد شيء هنا بعد',
    emptyHint: 'ستظهر هنا العناصر التي تملك صلاحية الوصول إليها.',
    error: 'حدث خطأ ما',
    errorHint: 'تم تسجيل المشكلة. حاول مرة أخرى أو تواصل مع المسؤول.',
    retry: 'إعادة المحاولة',
    notFound: 'الصفحة غير موجودة',
    notFoundHint: 'الصفحة المطلوبة غير موجودة، أو لا تملك صلاحية الوصول إليها.',
    offline: 'أنت غير متصل بالإنترنت',
  },
  auth: {
    signIn: 'تسجيل الدخول',
    signOut: 'تسجيل الخروج',
    sessionExpired: 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.',
    forbidden: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  },
  error: {
    VALIDATION_FAILED: 'بعض البيانات غير صحيحة.',
    NOT_FOUND: 'هذا العنصر غير موجود، أو لا تملك صلاحية الوصول إليه.',
    FORBIDDEN: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
    UNAUTHENTICATED: 'سجّل الدخول للمتابعة.',
    INVALID_TRANSITION: 'هذا التغيير غير مسموح من الحالة الحالية.',
    VERSION_CONFLICT: 'قام شخص آخر بالتعديل قبلك. أعد التحميل ثم حاول مجددًا.',
    DUPLICATE: 'هذا العنصر موجود مسبقًا.',
    LOCKED: 'هذه الوثيقة محجوزة للتعديل من مستخدم آخر.',
    LEGAL_HOLD: 'هذه الوثيقة خاضعة لحجز قانوني ولا يمكن حذفها.',
    QUOTA_EXCEEDED: 'مساحة التخزين المخصصة لك ممتلئة.',
    RATE_LIMITED: 'عدد كبير من الطلبات. انتظر قليلًا ثم حاول مجددًا.',
    UNSUPPORTED_CONTENT: 'نوع الملف غير مقبول.',
    CONTENT_NOT_SCANNED: 'ما زال يجري فحص هذا الملف للتأكد من خلوه من البرمجيات الخبيثة.',
    TENANT_READ_ONLY: 'مؤسستك في وضع القراءة فقط حاليًا.',
    DEPENDENCY_UNAVAILABLE: 'إحدى الخدمات اللازمة لهذا الإجراء غير متاحة.',
    INTERNAL: 'حدث خطأ لدينا.',
  },
};

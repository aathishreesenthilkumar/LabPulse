/**
 * LabPulse — constants and sheet schemas.
 *
 * Values admins tune in the field (radius, accuracy limit, speed limits, hours,
 * QR rotation) are per-lab settings managed in Settings.js, not constants here.
 */

var APP = {
  NAME: 'LabPulse',
  VERSION: '1.0.0',
  TZ: 'Asia/Kolkata',
  TZ_OFFSET_MIN: 330, // Asia/Kolkata has no daylight saving, so a fixed offset is exact.
  ALLOWED_DOMAINS: ['karunya.edu', 'karunya.edu.in'],

  RADIUS_MIN_M: 15, // FR-07: 15–20 m configurable radius
  RADIUS_MAX_M: 20,
  QR_ROTATE_MIN_SEC: 5, // FR-05: rotates every 5–10 seconds
  QR_ROTATE_MAX_SEC: 10,

  TOKEN_GRACE_WINDOWS: 2, // a QR is accepted for its own window plus this many previous ones
  TICKET_TTL_SEC: 300, // time between a successful scan and submitting the check-in form
  REQUEST_ID_TTL_SEC: 900, // idempotency memory for retried requests
  LASTPOS_TTL_SEC: 21600, // travel-speed memory (stores a distance scalar, never coordinates)
  USER_CACHE_SEC: 300,
  LOCK_WAIT_MS: 15000,
  ACTIVITY_LIMIT: 40,
  MANUAL_VISIT_HOURS: 3, // expected length of a staff manual entry made outside hours
  SESSION_EARLY_MIN: 30 // students may check in to a session this many minutes before it starts
};

/**
 * STUDENT      checks in, books equipment, records projects
 * FACULTY      runs course sessions: roster, who is missing, reviews
 * STAFF        lab assistant: monitor, equipment handover/return, manual entries
 * COORDINATOR  manages the lab: facilities (inventory), students, courses, plus all staff work
 * HOD          read-only view of every lab, its usage, projects and reports
 * SUPER_ADMIN  manages roles and system settings; may do everything
 */
var ROLES = {
  STUDENT: 'STUDENT',
  FACULTY: 'FACULTY',
  STAFF: 'STAFF',
  COORDINATOR: 'COORDINATOR',
  HOD: 'HOD',
  ADMIN: 'SUPER_ADMIN'
};
var ROLE_LIST = ['STUDENT', 'FACULTY', 'STAFF', 'COORDINATOR', 'HOD', 'SUPER_ADMIN'];

var STATUS = {
  VISIT: { ACTIVE: 'ACTIVE', CLOSED: 'CLOSED', VOIDED: 'VOIDED' },
  REVIEW: { NONE: '', PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', DECLINED: 'DECLINED' },
  CONF: { GREEN: 'GREEN', AMBER: 'AMBER', RED: 'RED', MANUAL: 'MANUAL' },
  CLOSE: {
    MANUAL: 'MANUAL',
    AUTO_DURATION: 'AUTO_DURATION',
    AUTO_CLOSING: 'AUTO_CLOSING',
    AUTO_SWITCH: 'AUTO_SWITCH',
    STAFF: 'STAFF',
    LEFT: 'LEFT_DURING_SESSION', // GPS live mode: out of the boundary or unseen for too long
    VOIDED: 'VOIDED'
  },
  ASSET: {
    AVAILABLE: 'AVAILABLE',
    RESERVED: 'RESERVED',
    ISSUED: 'ISSUED',
    MAINTENANCE: 'MAINTENANCE',
    RETIRED: 'RETIRED'
  },
  CONDITIONS: ['GOOD', 'FAIR', 'DAMAGED'],
  REQUEST: {
    PENDING: 'PENDING',
    FULFILLED: 'FULFILLED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    EXPIRED: 'EXPIRED'
  },
  LOAN: { ISSUED: 'ISSUED', OVERDUE: 'OVERDUE', RETURNED: 'RETURNED' },
  MARK: { PRESENT: 'PRESENT', ABSENT: 'ABSENT' }
};

var ENTRY_TYPES = { COURSE: 'COURSE', EVENT: 'EVENT', RESEARCH: 'RESEARCH' };

// FR-19 catalog plus the supervisor's list (3D printers, drones, lab computers with graphics cards).
// Category drives reports: GPU utilisation and sensor turnover.
var ASSET_CATALOG = {
  GPU: ['RTX 4090', 'A100'],
  COMPUTE: ['Lab PC (GPU)', 'Lab PC'],
  FABRICATION: ['3D Printer'],
  DRONE: ['Drone'],
  IOT: ['ESP32', 'Raspberry Pi', 'LoRaWAN Gateway'],
  SENSOR: ['Ultrasonic', 'Thermal', 'LiDAR', 'Gas']
};

// "Systems" a person works at during a visit (shown live: who is on which system).
var SYSTEM_CATEGORIES = ['GPU', 'COMPUTE', 'FABRICATION', 'DRONE'];
var OWN_DEVICE = 'OWN';

var DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * One tab per kind of record (SRS §7). Column order is fixed; the first column is the ID.
 * Columns ending in `_at` or named `timestamp` hold dates; every other column is plain text,
 * so Sheets never reinterprets times like "09:00", phone numbers or IDs.
 */
var SHEETS = {
  Users: ['user_id', 'email', 'name', 'reg_no', 'mobile', 'role', 'active', 'created_at', 'updated_at'],
  Config: [
    'lab_id', 'name', 'lat', 'lng', 'radius_m', 'open_time', 'close_time', 'open_days',
    'accuracy_limit_m', 'amber_margin_m', 'speed_flag_kmh', 'speed_block_kmh', 'qr_rotate_sec',
    'grace_min', 'incharge_email', 'map_cols', 'map_rows', 'active', 'updated_at'
  ],
  CoursesEvents: [
    'id', 'lab_id', 'type', 'code', 'name', 'coordinator_email', 'coordinator_name', 'days',
    'start_time', 'end_time', 'start_date', 'end_date', 'session_hours', 'active'
  ],
  Enrollments: ['session_id', 'user_email'],
  Visits: [
    'visit_id', 'user_id', 'email', 'lab_id', 'entry_type', 'course_or_event_id', 'purpose', 'details',
    'check_in_at', 'check_out_at', 'expected_end_at', 'is_valid_geofence', 'confidence',
    'confidence_reason', 'review_status', 'reviewed_by', 'reviewed_at', 'close_type', 'status',
    'created_by', 'request_id', 'system_id', 'project_id', 'work_note'
  ],
  ActiveVisits: [
    'visit_id', 'user_id', 'email', 'lab_id', 'check_in_at', 'expected_end_at', 'entry_type', 'course_or_event_id',
    'review_status', 'system_id', 'project_id'
  ],
  Bookings: [
    'booking_id', 'lab_id', 'asset_id', 'user_id', 'user_email', 'project_id', 'start_at', 'end_at', 'purpose', 'status',
    'created_at', 'started_at', 'finished_at', 'handled_by', 'note'
  ],
  Projects: [
    'project_id', 'lab_id', 'title', 'description', 'owner_email', 'members', 'start_date', 'end_date', 'status',
    'outcome', 'outcome_link', 'created_at', 'updated_at', 'archived_minutes'
  ],
  // Nightly summaries: one row per person per day, and per asset per day (kept forever, small).
  UsageDaily: ['date', 'lab_id', 'email', 'visits', 'minutes', 'first_in_at', 'last_out_at', 'projects', 'systems'],
  AssetUsageDaily: ['date', 'lab_id', 'asset_id', 'uses', 'minutes', 'users', 'purposes'],
  Assets: ['asset_id', 'lab_id', 'name', 'category', 'type', 'status', 'condition', 'location', 'map_x', 'map_y', 'notes', 'updated_at'],
  Requests: [
    'request_id', 'lab_id', 'asset_id', 'requester_id', 'requester_email', 'window_start_at',
    'window_end_at', 'note', 'status', 'decided_by', 'decided_at', 'decision_note', 'created_at'
  ],
  Loans: [
    'loan_id', 'lab_id', 'asset_id', 'request_id', 'borrower_id', 'borrower_email', 'issued_by',
    'issued_at', 'due_at', 'issue_condition', 'returned_at', 'returned_to', 'return_condition',
    'status', 'last_reminder_at'
  ],
  AttendanceMarks: ['mark_id', 'session_id', 'session_date', 'user_email', 'mark', 'reason', 'marked_by', 'marked_at'],
  AuditLog: ['event_id', 'timestamp', 'actor', 'role', 'action', 'target', 'outcome', 'reason', 'lab_id']
};

function isDateColumn_(name) {
  return name === 'timestamp' || /_at$/.test(name);
}

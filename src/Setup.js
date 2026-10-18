/**
 * One-time setup, run from the Apps Script editor by the deploying account.
 *
 *   1. (optional) Script Properties → BOOTSTRAP_ADMINS = comma-separated admin emails
 *   2. Run setup()          — creates the data spreadsheet, tabs, secret and first lab
 *   3. Run seedDemoData()   — optional demo catalog, courses and an all-day demo session
 *   4. Run installTriggers()
 *   5. Deploy → New deployment → Web app
 */

function setup() {
  guardJob_();
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) ss = SpreadsheetApp.openById(id);
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) ss = SpreadsheetApp.create('LabPulse Data');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  Db.forget();

  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SHEETS[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    for (var c = 0; c < cols.length; c++) {
      // Text columns stay text so "09:00", "0094…" or "=…" are stored exactly as written.
      sh.getRange(2, c + 1, sh.getMaxRows() - 1, 1).setNumberFormat(isDateColumn_(cols[c]) ? 'yyyy-mm-dd hh:mm:ss' : '@');
    }
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  ss.setSpreadsheetTimeZone(APP.TZ);

  Settings.secret();

  if (!Db.all('Config').length) {
    Db.insert('Config', {
      lab_id: 'AIIOT', name: 'AI & IoT Lab', lat: 10.9364, lng: 76.7442, radius_m: 20,
      open_time: '08:00', close_time: '20:00', open_days: 'MON,TUE,WED,THU,FRI,SAT',
      accuracy_limit_m: 30, amber_margin_m: 30, speed_flag_kmh: 25, speed_block_kmh: 200,
      qr_rotate_sec: 8, grace_min: 15, incharge_email: '', map_cols: 8, map_rows: 5,
      active: true, updated_at: U.now()
    });
  }
  Settings.syncFromSheet();

  var admins = U.str(props.getProperty('BOOTSTRAP_ADMINS')).toLowerCase().split(/[\s,;]+/).filter(U.isEmail);
  var owner = U.str(Session.getEffectiveUser().getEmail()).toLowerCase();
  if (owner && Auth.isAllowedEmail(owner)) admins.push(owner);
  admins.forEach(function (email) {
    var row = Db.findOne('Users', function (u) { return u.email === email; });
    if (row) {
      if (row.role !== ROLES.ADMIN) Db.update('Users', row, { role: ROLES.ADMIN, active: true, updated_at: U.now() });
    } else {
      Db.insert('Users', {
        user_id: U.id('U'), email: email, name: '', reg_no: '', mobile: '', role: ROLES.ADMIN,
        active: true, created_at: U.now(), updated_at: U.now()
      });
    }
    Auth.invalidate(email);
  });
  Audit.log(null, 'SETUP', ss.getId(), 'OK', 'admins=' + admins.join(','), '');
  console.log('LabPulse data spreadsheet: ' + ss.getUrl());
  console.log('Super Admins: ' + (admins.join(', ') || 'none — set BOOTSTRAP_ADMINS and run setup() again'));
  console.log('Next: set the real lab coordinates in Admin › Settings, then run installTriggers().');
  return ss.getUrl();
}

/** Demo data for the review: an FR-19 catalog laid out on the lab map, plus sessions. */
function seedDemoData() {
  guardJob_();
  var lab = Settings.labs(false)[0];
  if (!lab) throw new Error('Run setup() first.');
  return withLock_(function () {
    var now = U.now();
    if (!Db.find('Assets', function (a) { return a.lab_id === lab.lab_id; }).length) {
      var items = [
        ['GPU-01', 'RTX 4090 Workstation 1', 'GPU', 'RTX 4090', 'WS-01', 0, 0],
        ['GPU-02', 'RTX 4090 Workstation 2', 'GPU', 'RTX 4090', 'WS-02', 1, 0],
        ['GPU-03', 'RTX 4090 Workstation 3', 'GPU', 'RTX 4090', 'WS-03', 2, 0],
        ['GPU-04', 'A100 Node', 'GPU', 'A100', 'WS-04', 3, 0],
        ['ESP-01', 'ESP32 DevKit #1', 'IOT', 'ESP32', 'Bench A', 0, 2],
        ['ESP-02', 'ESP32 DevKit #2', 'IOT', 'ESP32', 'Bench A', 1, 2],
        ['ESP-03', 'ESP32 DevKit #3', 'IOT', 'ESP32', 'Bench A', 2, 2],
        ['ESP-04', 'ESP32 DevKit #4', 'IOT', 'ESP32', 'Bench B', 3, 2],
        ['ESP-05', 'ESP32 DevKit #5', 'IOT', 'ESP32', 'Bench B', 4, 2],
        ['RPI-01', 'Raspberry Pi 5 #1', 'IOT', 'Raspberry Pi', 'Bench C', 5, 2],
        ['RPI-02', 'Raspberry Pi 5 #2', 'IOT', 'Raspberry Pi', 'Bench C', 6, 2],
        ['RPI-03', 'Raspberry Pi 5 #3', 'IOT', 'Raspberry Pi', 'Bench C', 7, 2],
        ['LORA-01', 'LoRaWAN Gateway #1', 'IOT', 'LoRaWAN Gateway', 'Rack', 6, 0],
        ['LORA-02', 'LoRaWAN Gateway #2', 'IOT', 'LoRaWAN Gateway', 'Rack', 7, 0],
        ['US-01', 'Ultrasonic Sensor HC-SR04 #1', 'SENSOR', 'Ultrasonic', 'Cabinet', 0, 4],
        ['US-02', 'Ultrasonic Sensor HC-SR04 #2', 'SENSOR', 'Ultrasonic', 'Cabinet', 1, 4],
        ['TH-01', 'Thermal Camera #1', 'SENSOR', 'Thermal', 'Cabinet', 2, 4],
        ['TH-02', 'Thermal Camera #2', 'SENSOR', 'Thermal', 'Cabinet', 3, 4],
        ['LDR-01', 'LiDAR Unit', 'SENSOR', 'LiDAR', 'Cabinet', 4, 4],
        ['GAS-01', 'Gas Sensor MQ-2 #1', 'SENSOR', 'Gas', 'Cabinet', 5, 4],
        ['GAS-02', 'Gas Sensor MQ-2 #2', 'SENSOR', 'Gas', 'Cabinet', 6, 4]
      ];
      Db.insertMany('Assets', items.map(function (i) {
        return {
          asset_id: i[0], lab_id: lab.lab_id, name: i[1], category: i[2], type: i[3], status: STATUS.ASSET.AVAILABLE,
          condition: 'GOOD', location: i[4], map_x: i[5], map_y: i[6], notes: '', updated_at: now
        };
      }));
    }
    var me = U.str(Session.getEffectiveUser().getEmail()).toLowerCase();
    if (!Db.find('CoursesEvents', function (s) { return s.lab_id === lab.lab_id; }).length) {
      var today = U.dateKey(now);
      Db.insertMany('CoursesEvents', [
        {
          id: 'C-DEMO', lab_id: lab.lab_id, type: 'COURSE', code: 'DEMO101', name: 'Demo Lab Session (all day)',
          coordinator_email: me, coordinator_name: 'Demo Coordinator', days: 'SUN,MON,TUE,WED,THU,FRI,SAT',
          start_time: lab.open_time, end_time: lab.close_time, start_date: '', end_date: '', session_hours: '2', active: true
        },
        {
          id: 'C-23CS2048', lab_id: lab.lab_id, type: 'COURSE', code: '23CS2048', name: 'Web Technology Lab',
          coordinator_email: me, coordinator_name: 'Dr. I. Titus', days: 'MON,WED',
          start_time: '10:00', end_time: '12:00', start_date: '', end_date: '', session_hours: '2', active: true
        },
        {
          id: 'EV-HACK', lab_id: lab.lab_id, type: 'EVENT', code: 'HACK26', name: 'IoT Hackathon 2026',
          coordinator_email: me, coordinator_name: 'Hackathon Desk', days: '', start_time: '', end_time: '',
          start_date: today, end_date: U.addDays(today, 2), session_hours: '6', active: true
        }
      ]);
    }
    Audit.log(null, 'SEED_DEMO', lab.lab_id, 'OK', '', lab.lab_id);
    return 'Demo data ready for ' + lab.lab_id;
  });
}

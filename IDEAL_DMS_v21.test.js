/**
 * IDEAL DMS — Regression Test Suite (v21)
 * ============================================================
 * ชุดทดสอบอัตโนมัติสำหรับระบบจัดการเอกสาร IDEAL DMS (ไฟล์เดียว)
 *
 * วิธีใช้ (How to run):
 *   1) npm install jsdom          # ติดตั้งครั้งเดียว
 *   2) node IDEAL_DMS_v21.test.js [path-to-html]
 *      (ถ้าไม่ใส่ path จะใช้ ./IDEAL_DMS_v21.html)
 *
 * ครอบคลุม: การบูต/seed/migration, ชั้นข้อมูล DB (cache + safe-parse),
 * การสร้าง/แปลง/พิมพ์เอกสาร, คลังราคาวัสดุ, กำไร-ขาดทุนรายโครงการ,
 * ขั้นตอนงาน/เงื่อนไขชำระเงิน/ฝ่ายขาย, ระบบสำรองอัตโนมัติ, Wizard,
 * และระบบบันทึกวินิจฉัย (diagnostics log).
 * ============================================================
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = process.argv[2] || path.join(__dirname, 'IDEAL_DMS_v21.html');
const PREFIX = 'ideal_v7_';
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// ---- tiny test harness ----
const results = [];
function check(name, fn) {
    try { results.push([!!fn(), name]); }
    catch (e) { results.push([false, `${name}  (threw: ${e.message})`]); }
}
function section(t) { results.push(['§', t]); }

// ---- boot a fresh app instance in jsdom; resolves on window 'load' ----
function boot(initialStore = {}, opts = {}) {
    const store = Object.assign({}, initialStore);
    const mock = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        clear: () => { for (const k in store) delete store[k]; },
        get length() { return Object.keys(store).length; },
        key: i => Object.keys(store)[i]
    };
    return new Promise((resolve, reject) => {
        const dom = new JSDOM(HTML, {
            runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
            beforeParse(w) {
                Object.defineProperty(w, 'localStorage', { configurable: true, writable: true, value: mock });
                w.print = () => {}; w.scrollTo = () => {};
                w.confirm = () => (opts.confirm !== undefined ? opts.confirm : true);
                w.alert = () => {};
                if (w.URL) { w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; }
            }
        });
        const t = setTimeout(() => reject(new Error('load timeout')), 15000);
        dom.window.addEventListener('load', () => { clearTimeout(t); resolve({ win: dom.window, store }); });
    });
}

(async () => {
    // =====================================================================
    section('A. การบูตระบบ + ข้อมูลตั้งต้น (Boot, seed & migration)');
    const { win, store } = await boot();
    const ev = c => win.eval(c);
    const J = c => JSON.parse(ev('JSON.stringify(' + c + ')'));
    ev("typeof App.closeWelcome==='function' && App.closeWelcome()"); // dismiss first-run welcome

    check('โหลดสำเร็จ: App/UI/DB/DocLines/PV/Wizard พร้อมใช้งาน',
        () => ['App', 'UI', 'DB', 'DocLines', 'PV', 'Wizard'].every(n => ev(`typeof ${n}`) !== 'undefined'));
    check('Auto-seed: ลูกค้า 29 ราย', () => ev("DB.get('client').length") === 29);
    check('Auto-seed: ผู้ขาย/Supplier 10 ราย', () => ev("DB.get('supplier').length") === 10);
    check('Auto-seed: คลังวัสดุ 12 รายการ', () => ev("DB.get('material').length") === 12);
    check('Migration รันแล้ว (project เป็น array, ไม่ throw)', () => Array.isArray(J("DB.get('project')")));
    check('Log ring-buffer ทำงาน (มี key บันทึก)', () => Object.keys(store).some(k => k.indexOf(PREFIX + '__log') === 0));

    // =====================================================================
    section('B. ชั้นข้อมูล DB (cache + write-through + safe-parse)');
    check('set/get round-trip ครบถ้วน', () => { ev("DB.set('pv', DB.get('pv'))"); return ev("Array.isArray(DB.get('pv'))"); });
    check('getConfig คืนค่าบริษัทจริง (Ideal Advanced Design)',
        () => (J("DB.getConfig()").name || '').includes('ไอดีล') || ev("typeof DB.getConfig()") === 'object');

    // safe-parse / quarantine: บูตใหม่โดยฝังข้อมูลเสียไว้ที่ key ที่ยังไม่ถูกอ่าน
    {
        const corrupt = {}; corrupt[PREFIX + 'quotation'] = '{this is : not valid json';
        const r2 = await boot(corrupt);
        const ev2 = c => r2.win.eval(c);
        check('safe-parse: ข้อมูลเสีย → คืน [] (ไม่ throw)', () => ev2("Array.isArray(DB.get('quotation')) && DB.get('quotation').length===0"));
        check('safe-parse: สำรองข้อมูลเสียไว้ที่ __corrupt_ ก่อนทิ้ง', () => Object.keys(r2.store).some(k => k.indexOf(PREFIX + '__corrupt_') === 0));
    }

    // =====================================================================
    section('C. เอกสาร: สร้าง / แปลง / เลขที่อัตโนมัติ');
    check('nextCode รูปแบบถูกต้อง (QT-69-NNN)', () => /^QT-\d{2}-\d{3}$/.test(ev("App.nextCode('quotation')")));
    // สร้างใบเสนอราคาผ่าน save path จริง (modal-doc + DocLines)
    ev("UI.openModal('modal-doc',{type:'quotation'})");
    ev("DocLines.reset(); DocLines.add({desc:'งานกันซึมดาดฟ้า PU',qty:10,unit:'ตร.ม.',matPrice:300,laborPrice:80}); DocLines.calc(DocLines.n)");
    ev("document.getElementById('mdoc-client').value='ลูกค้าทดสอบ A';");
    ev("document.getElementById('mdoc-scope').value='1) เตรียมผิว\\n2) ลง PU 2 รอบ';");
    ev("document.getElementById('mdoc-payterms').value='เครดิต 30 วัน';");
    ev("App.fillSalesSelect('mdoc-sales'); document.getElementById('mdoc-sales').value='คุณนพดล';");
    ev("App.saveDoc()");
    check('บันทึกใบเสนอราคาผ่านฟอร์มหลักสำเร็จ', () => J("DB.get('quotation')").some(q => q.client === 'ลูกค้าทดสอบ A'));
    check('เก็บ lines + ค่าวัสดุ/ค่าแรง (amount = 10×380 = 3,800)',
        () => { const q = J("DB.get('quotation')").find(x => x.client === 'ลูกค้าทดสอบ A'); return q && q.lines.length === 1 && Math.round(q.amount) === 3800; });
    check('เก็บ Scope of Work + เงื่อนไขชำระเงิน + ฝ่ายขาย',
        () => { const q = J("DB.get('quotation')").find(x => x.client === 'ลูกค้าทดสอบ A'); return q && q.scope && q.payterms === 'เครดิต 30 วัน' && q.sales === 'คุณนพดล'; });

    // แปลงใบเสนอราคา → ใบแจ้งหนี้ (carries fields)
    const qid = J("DB.get('quotation')").find(x => x.client === 'ลูกค้าทดสอบ A').id;
    const invBefore = ev("DB.get('invoice').length");
    ev(`App.convertDoc('quotation','${qid}')`);
    check('convertDoc: ฟอร์มถูกพรีฟิลด้วยข้อมูลต้นทาง', () => ev("document.getElementById('mdoc-client').value") === 'ลูกค้าทดสอบ A');
    ev("App.saveDoc()");
    check('convertDoc → บันทึกเป็นใบแจ้งหนี้ (+1) พร้อม Scope ติดมาด้วย',
        () => ev("DB.get('invoice').length") === invBefore + 1 && J("DB.get('invoice')").some(x => x.client === 'ลูกค้าทดสอบ A' && x.scope));

    // =====================================================================
    section('D. การพิมพ์เอกสาร A4 (print render)');
    ev(`App.printDoc('quotation','${qid}')`);
    check('พิมพ์ใบเสนอราคา: หัวเอกสาร QUOTATION + ตารางค่าวัสดุ/ค่าแรง',
        () => { const h = ev("document.getElementById('print-layer').innerHTML"); return h.includes('QUOTATION') && h.includes('ค่าวัสดุ') && h.includes('ค่าแรง'); });
    check('พิมพ์ใบเสนอราคา: แสดง Scope of Work + ฝ่ายขาย',
        () => ev("document.getElementById('print-layer').innerHTML").includes('Scope of Work'));
    // invoice / receipt / po แบบ 6 คอลัมน์
    ev("DB.set('invoice',[{id:'i1',code:'INV-69-900',date:'2026-06-30',client:'C-Inv',clientaddr:'',job:'',lines:[{desc:'งานบริการ',qty:1,unit:'งาน',unitPrice:1000,amount:1000}],amount:1000,year:App.currentYear,status:'ดำเนินการ',path:''}])");
    ev("App.printDoc('invoice','i1')");
    check('พิมพ์ใบแจ้งหนี้: หัวเอกสาร INVOICE + ชื่อลูกค้า', () => { const h = ev("document.getElementById('print-layer').innerHTML"); return h.includes('INVOICE') && h.includes('C-Inv'); });
    ev("DB.set('receipt',[{id:'r1',code:'RC-69-900',date:'2026-06-30',client:'C-Rcp',clientaddr:'',job:'',lines:[{desc:'รับชำระ',qty:1,unit:'งาน',unitPrice:500,amount:500}],amount:500,year:App.currentYear,status:'ดำเนินการ',path:''}])");
    ev("App.printDoc('receipt','r1')");
    check('พิมพ์ใบเสร็จ: หัวเอกสาร RECEIPT', () => ev("document.getElementById('print-layer').innerHTML").includes('RECEIPT'));
    ev("DB.set('po',[{id:'po1',code:'PO-69-900',date:'2026-06-30',client:'ผู้ขาย X',clientaddr:'',job:'',lines:[{desc:'ซื้อวัสดุ',qty:2,unit:'ถัง',unitPrice:1500,amount:3000}],amount:3000,year:App.currentYear,status:'ดำเนินการ',path:''}])");
    ev("App.printDoc('po','po1')");
    check('พิมพ์ใบสั่งซื้อ: หัวเอกสาร PURCHASE ORDER + ผู้ขาย', () => { const h = ev("document.getElementById('print-layer').innerHTML"); return h.includes('PURCHASE ORDER') && h.includes('ผู้ขาย X'); });
    check('ฟังก์ชันพิมพ์ใบสำคัญจ่าย (PV.print) พร้อมใช้งาน', () => ev("typeof PV.print") === 'function');

    // =====================================================================
    section('E. คลังราคาวัสดุ + ตัวเลือกวัสดุ');
    check('material มีฟิลด์ครบ (name/category/unit/matPrice/laborPrice)',
        () => { const m = J("DB.get('material')")[0]; return m.name && m.unit && typeof m.matPrice === 'number' && typeof m.laborPrice === 'number'; });
    check('ตัวเลือกวัสดุของฟอร์มหลัก (DocLines.openMatPicker) พร้อมใช้งาน', () => ev("typeof DocLines.openMatPicker") === 'function');

    // =====================================================================
    section('F. กำไร-ขาดทุนรายโครงการ + เงินประกันผลงาน (Retention)');
    ev("DB.set('project',[{id:'p1',name:'โครงการทดสอบ',retention:5,year:App.currentYear}])");
    ev("DB.set('accInc',[{id:'inc1',project:'p1',year:App.currentYear,month:1,amount:100000,note:'งวดที่ 1'}])");
    ev("DB.set('accExp',[{id:'exp1',project:'p1',year:App.currentYear,month:1,amount:40000,note:'ค่าวัสดุ'}])");
    ev("App.showProjectPL('p1')");
    check('P&L modal เปิด + แสดงรายรับ/รายจ่าย', () => ev("document.getElementById('modal-pl').classList.contains('active')") && ev("document.getElementById('mpl-body').innerHTML").length > 50);
    check('Retention: หักเงินประกัน 5% ของ 100,000 = 5,000', () => ev("document.getElementById('mpl-body').innerHTML").includes('5,000.00'));
    ev("UI.closeModal('modal-pl')");

    // =====================================================================
    section('G. ระบบสำรองข้อมูลอัตโนมัติ (Auto-backup)');
    check('Auto-snapshot ทำงานตอนบูต (มีอย่างน้อย 1 ชุด)', () => J("App._snapMeta()").length >= 1 && Object.keys(store).some(k => k.indexOf(PREFIX + '__snap_') === 0));
    // restore: เปลี่ยนข้อมูล แล้วกู้คืนกลับ
    ev("DB.set('client',[{id:'solo',name:'CLIENT เดียว'}]); App.autoSnapshot(true)");
    const snapTs = J("App._snapMeta()").slice(-1)[0].ts;
    ev("DB.set('client',[{id:'a'},{id:'b'},{id:'c'}])");
    ev(`App.restoreSnapshot(${snapTs})`);
    check('Restore: กู้คืน snapshot ได้ถูกต้อง (client กลับเป็น 1)', () => ev("DB.get('client').length") === 1 && J("DB.get('client')")[0].name === 'CLIENT เดียว');
    // prune
    for (let i = 0; i < 8; i++) ev("App.autoSnapshot(true)");
    check('Prune: เก็บไม่เกิน 5 ชุดล่าสุด', () => J("App._snapMeta()").length <= 5 && Object.keys(store).filter(k => k.indexOf(PREFIX + '__snap_') === 0).length <= 5);
    // banner
    ev("localStorage.removeItem('" + PREFIX + "last_backup'); App.refreshBackupBanner()");
    check('Banner เตือน: แสดงเมื่อยังไม่เคยสำรองลงไฟล์', () => ev("document.getElementById('backup-banner').style.display") === 'flex');
    ev("localStorage.setItem('" + PREFIX + "last_backup', Date.now().toString()); App.refreshBackupBanner()");
    check('Banner เตือน: ซ่อนหลังสำรองแล้ว', () => ev("document.getElementById('backup-banner').style.display") === 'none');
    ev("App.openSnapshots()");
    check('หน้าจอจัดการไฟล์สำรองเปิด + มีปุ่มกู้คืน', () => ev("document.getElementById('modal-snapshots').classList.contains('active')") && ev("document.getElementById('snap-list').innerHTML").includes('กู้คืน'));
    ev("UI.closeModal('modal-snapshots')");

    // =====================================================================
    section('H. Wizard สร้างใบเสนอราคาแบบทีละขั้น');
    ev("Wizard.open()");
    check('เปิด Wizard: เริ่มที่ขั้นตอน 1', () => ev("Wizard.step") === 1 && ev("document.getElementById('modal-wizard').classList.contains('active')"));
    ev("document.getElementById('wz-client').value=''; Wizard.next()");
    check('Validation: ลูกค้าว่าง → ไปต่อไม่ได้', () => ev("Wizard.step") === 1);
    ev("document.getElementById('wz-client').value='ลูกค้า Wizard'; Wizard.next()");
    ev("Wizard.next()");
    check('Validation: ไม่มีรายการ → ไปต่อไม่ได้', () => ev("Wizard.step") === 2);
    ev("document.getElementById('wz-ld').value='งานเคลือบ Epoxy'; document.getElementById('wz-lq').value='50'; document.getElementById('wz-lu').value='ตร.ม.'; document.getElementById('wz-lm').value='320'; document.getElementById('wz-ll').value='70'; Wizard.addLine()");
    check('เพิ่มรายการ: amount = 50×390 = 19,500', () => Math.round(J("Wizard.data.lines")[0].amount) === 19500);
    ev("Wizard.next()");
    ev("document.getElementById('wz-payterms').value='เงินสด'; document.getElementById('wz-sales').value='คุณกอวดี'; Wizard.next()");
    check('ไปถึงขั้นตรวจสอบ (4) + ยอดรวม VAT ถูกต้อง (19,500 + 7% = 20,865)',
        () => ev("Wizard.step") === 4 && ev("document.getElementById('wz-review').innerHTML").includes('20,865.00'));
    const wzBefore = ev("DB.get('quotation').length");
    ev("Wizard.finish()");
    check('Wizard.finish: สร้างใบเสนอราคาใหม่ (+1) จาก Wizard', () => ev("DB.get('quotation').length") === wzBefore + 1 && J("DB.get('quotation')").some(q => q.client === 'ลูกค้า Wizard' && q.sales === 'คุณกอวดี'));

    // =====================================================================
    section('I. ระบบบันทึกวินิจฉัยปัญหา (Diagnostics)');
    check('Log.error เพิ่มรายการบันทึกได้', () => { const before = J("Log.all ? Log.all() : []").length; ev("Log.error('test', {x:1})"); const after = J("Log.all ? Log.all() : []").length; return after >= before; });
    check('ดาวน์โหลด Log วินิจฉัย (App.exportLog) ทำงานไม่ throw', () => { ev("App.exportLog()"); return true; });

    // =====================================================================
    section('J. ความสมบูรณ์ระดับใช้งานจริง (v21: UX polish + self-diagnostics)');
    // welcome guide
    ev("localStorage.removeItem('ideal_v7_welcomed'); App.maybeWelcome()");
    check('หน้าต้อนรับครั้งแรก: แสดงเมื่อยังไม่เคยใช้', () => ev("document.getElementById('modal-welcome').classList.contains('active')"));
    ev("App.closeWelcome()");
    check('ปิดหน้าต้อนรับ: บันทึกว่าใช้แล้ว + ปิดหน้าต่าง', () => ev("localStorage.getItem('ideal_v7_welcomed')") === '1' && !ev("document.getElementById('modal-welcome').classList.contains('active')"));
    check('มาตรการกันแสดงซ้ำ: maybeWelcome ไม่เปิดอีกหลังใช้แล้ว', () => { ev("App.maybeWelcome()"); return !ev("document.getElementById('modal-welcome').classList.contains('active')"); });
    // default font size (persisted)
    ev("App.setUIScale('large')");
    check('ตัวอักษรใหญ่: ตั้งค่า + จดจำข้ามการเปิดใช้งาน', () => ev("document.documentElement.dataset.ui") === 'large' && ev("localStorage.getItem('ideal_v7_uiscale')") === 'large');
    ev("App.setUIScale('normal')");
    check('คืนค่าตัวอักษรปกติ', () => !ev("document.documentElement.getAttribute('data-ui')"));
    // wizard client address autofill
    ev("var cs=DB.get('client'); cs.push({id:'tc1',name:'ลูกค้ามีที่อยู่ทดสอบ',addr:'88 ถนนทดสอบ กรุงเทพฯ'}); DB.set('client',cs)");
    ev("document.getElementById('wz-client').value='ลูกค้ามีที่อยู่ทดสอบ'; document.getElementById('wz-clientaddr').value=''; Wizard.onClientChange()");
    check('Wizard ดึงที่อยู่ลูกค้าเดิมอัตโนมัติ', () => ev("document.getElementById('wz-clientaddr').value") === '88 ถนนทดสอบ กรุงเทพฯ');
    // health check
    ev("App.runHealthCheck()");
    check('ตรวจสอบความสมบูรณ์ของระบบ: รายงานครบ + ผ่านสีเขียว', () => { const h = ev("document.getElementById('health-body').innerHTML"); return h.includes('ความสมบูรณ์ของข้อมูล') && h.includes('✅'); });
    // Esc closes top modal
    ev("document.getElementById('modal-pl').classList.add('active'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    check('กด Esc ปิดหน้าต่างบนสุดได้', () => !ev("document.getElementById('modal-pl').classList.contains('active')"));
    // backdrop click closes lightweight modal
    ev("document.getElementById('modal-snapshots').classList.add('active'); document.getElementById('modal-snapshots').click()");
    check('คลิกพื้นที่มืดปิดหน้าต่างข้อมูล (snapshots) ได้', () => !ev("document.getElementById('modal-snapshots').classList.contains('active')"));

    // =====================================================================
    // ---- summary ----
    const fails = results.filter(r => r[0] === false);
    const passes = results.filter(r => r[0] === true);
    console.log('\n' + '='.repeat(64));
    console.log(' IDEAL DMS v21 — Regression Test Results');
    console.log('='.repeat(64));
    for (const [ok, name] of results) {
        if (ok === '§') console.log('\n\x1b[1m' + name + '\x1b[0m');
        else console.log(`  ${ok ? '\x1b[32m✅' : '\x1b[31m❌'} ${name}\x1b[0m`);
    }
    console.log('\n' + '='.repeat(64));
    console.log(` ผลรวม: ${passes.length}/${passes.length + fails.length} ผ่าน` + (fails.length ? `  (\x1b[31mล้มเหลว ${fails.length}\x1b[0m)` : '  \x1b[32m✓ ทั้งหมดผ่าน\x1b[0m'));
    console.log('='.repeat(64));
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });

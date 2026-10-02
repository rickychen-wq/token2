(function (global) {
'use strict';

var T = global.THREE;
var STAGES = [
  { id: 1, code: 'I',  name: '荒原木屋', sub: '生存據點', file: 'assets/estate/models/stage-1-hut.glb', scale: 11.5 },
  { id: 2, code: 'II', name: '森影古寺', sub: '靜謐領地', file: 'assets/estate/models/stage-2-temple.glb', scale: 12.5 },
  { id: 3, code: 'III',name: '東方名邸', sub: '繁華宅院', file: 'assets/estate/models/stage-3-manor.glb', scale: 13 },
  { id: 4, code: 'IV', name: '深淵門邸', sub: '要塞門庭', file: 'assets/estate/models/stage-4-gatehouse.glb', scale: 13 },
  { id: 5, code: 'V',  name: '黯星城塞', sub: '終局領域', file: 'assets/estate/models/stage-5-citadel.glb', scale: 14 }
];
var E = { root: null, ctx: null, active: false, raf: 0, stage: 1, integrity: 100, night: false, token: 0, fx: [], timers: [], model: null, disposed: true };

function addStyle() {
  if (document.getElementById('estate-style')) return;
  var style = document.createElement('style'); style.id = 'estate-style';
  style.textContent = [
    '.estate-mode .views{max-width:none;padding:0 0 calc(62px + var(--safe-b));overflow:hidden}.estate-mode .top-in,.estate-mode .tabs-in{max-width:1180px}.estate-view{height:calc(100dvh - 124px);min-height:560px}',
    '.estate-boot{height:100%;display:grid;place-content:center;justify-items:center;gap:12px;text-align:center;background:radial-gradient(circle at 50% 38%,#18314d,#050a13 62%)}.estate-boot span{width:42px;height:42px;border:2px solid #27445d;border-top-color:#7ce6ff;border-radius:50%;animation:estateSpin .8s linear infinite}.estate-boot b{font:800 18px var(--ui);letter-spacing:.08em}.estate-boot small{color:var(--faint)}.estate-boot.error b{color:#ff91a4}@keyframes estateSpin{to{transform:rotate(360deg)}}',
    '.estate-shell{position:relative;height:100%;overflow:hidden;background:#060b12;isolation:isolate}.estate-canvas{display:block;width:100%;height:100%;touch-action:none}.estate-vignette{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(2,6,12,.72),transparent 24%,transparent 66%,rgba(2,6,12,.83)),radial-gradient(ellipse at center,transparent 42%,rgba(0,0,0,.42))}',
    '.estate-head{position:absolute;z-index:3;top:14px;left:16px;right:16px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;pointer-events:none}.estate-title{min-width:0}.estate-kicker{font:800 9px var(--ui);letter-spacing:.25em;color:#8eeaff}.estate-title h1{margin:4px 0 2px;font:900 clamp(22px,4vw,34px)/1.1 var(--ui);letter-spacing:.04em;text-shadow:0 2px 18px #000}.estate-title p{color:#a8bccb;font-size:11px}.estate-private{padding:7px 10px;border:1px solid rgba(126,228,255,.28);border-radius:999px;color:#a7efff;background:rgba(4,13,24,.72);font:800 9px var(--ui);letter-spacing:.12em;white-space:nowrap;backdrop-filter:blur(9px)}',
    '.estate-stats{position:absolute;z-index:3;top:89px;left:16px;display:grid;grid-template-columns:repeat(3,auto);gap:7px;pointer-events:none}.estate-stat{min-width:86px;padding:9px 11px;border:1px solid rgba(114,218,255,.18);border-radius:10px;background:rgba(4,12,23,.72);backdrop-filter:blur(9px)}.estate-stat small{display:block;color:#718b9e;font-size:8px}.estate-stat b{display:block;margin-top:2px;font:800 13px var(--ui);color:#e7f8ff}.estate-integrity{color:#6df1b5!important}',
    '.estate-actions{position:absolute;z-index:4;right:16px;top:88px;display:flex;flex-direction:column;gap:7px}.estate-action{display:flex;align-items:center;gap:8px;min-width:116px;padding:10px 12px;border-radius:9px;color:#dceef8;background:rgba(4,12,23,.78);border:1px solid rgba(114,218,255,.18);backdrop-filter:blur(9px);font:700 11px var(--tc);cursor:pointer}.estate-action i{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;font:900 12px var(--ui);font-style:normal;color:#84e8ff;background:rgba(83,211,255,.09)}.estate-action.danger i{color:#ff94a8;background:rgba(255,72,104,.1)}.estate-action:active{transform:scale(.97)}',
    '.estate-tip{position:absolute;z-index:3;left:50%;bottom:112px;transform:translateX(-50%);padding:7px 12px;border-radius:99px;color:#8299aa;background:rgba(3,9,17,.68);font-size:9px;white-space:nowrap;pointer-events:none;backdrop-filter:blur(7px)}',
    '.estate-dock{position:absolute;z-index:4;left:14px;right:14px;bottom:14px;display:grid;grid-template-columns:repeat(5,1fr);gap:7px;padding:8px;border:1px solid rgba(105,214,255,.18);border-radius:16px;background:rgba(3,9,18,.84);backdrop-filter:blur(14px)}.estate-stage{min-width:0;padding:10px 5px;border-radius:10px;color:#71899c;background:transparent;border:1px solid transparent;text-align:center;cursor:pointer}.estate-stage strong{display:block;color:#9fb4c4;font:900 12px var(--ui)}.estate-stage b{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.estate-stage small{display:block;margin-top:2px;font-size:7px;color:#5d7487}.estate-stage.on{border-color:rgba(104,227,255,.52);background:linear-gradient(145deg,rgba(72,210,255,.15),rgba(113,78,255,.13));box-shadow:inset 0 0 20px rgba(85,201,255,.07)}.estate-stage.on strong,.estate-stage.on b{color:#bff5ff}',
    '.estate-load{position:absolute;z-index:5;inset:0;display:grid;place-content:center;justify-items:center;gap:11px;background:rgba(2,7,13,.58);backdrop-filter:blur(5px);transition:opacity .25s}.estate-load[hidden]{display:none}.estate-load-ring{width:45px;height:45px;border-radius:50%;border:2px solid rgba(112,226,255,.16);border-top-color:#86eaff;animation:estateSpin .8s linear infinite}.estate-load b{font:800 12px var(--ui)}.estate-load small{color:#84a1b5;font:700 10px var(--ui)}',
    '.estate-toast{position:absolute;z-index:7;left:50%;top:44%;transform:translate(-50%,-50%) scale(.94);padding:12px 18px;border-radius:10px;color:#dff8ff;background:rgba(3,12,24,.88);border:1px solid rgba(119,229,255,.35);box-shadow:0 18px 70px #000;opacity:0;pointer-events:none;font:800 12px var(--ui);transition:.2s}.estate-toast.on{opacity:1;transform:translate(-50%,-50%) scale(1)}',
    '@media(max-width:600px){.estate-view{height:calc(100dvh - 124px);min-height:520px}.estate-head{top:10px;left:12px;right:12px}.estate-title h1,.estate-title p{display:none}.estate-private{font-size:7px;padding:6px 8px}.estate-stats{top:64px;left:12px;right:12px;grid-template-columns:repeat(3,1fr)}.estate-stat{min-width:0;padding:7px 8px}.estate-stat b{font-size:11px}.estate-actions{top:auto;left:12px;right:12px;bottom:103px;display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.estate-action{min-width:0;justify-content:center;padding:8px 3px;font-size:9px}.estate-action i{display:none}.estate-tip{bottom:151px;font-size:8px}.estate-dock{left:8px;right:8px;bottom:8px;gap:2px;padding:6px}.estate-stage{padding:8px 2px}.estate-stage b{font-size:8px}.estate-stage small{display:none}}'
  ].join('');
  document.head.appendChild(style);
}

function markup(ctx) {
  var name = (ctx.player && ctx.player.name) || (ctx.me && ctx.me.name) || 'ADMIN';
  return '<div class="estate-shell"><canvas class="estate-canvas" aria-label="3D 領地測試場景"></canvas><div class="estate-vignette"></div>' +
    '<div class="estate-head"><div class="estate-title"><div class="estate-kicker">PRIVATE DISTRICT · CITY 01</div><h1>私人領地</h1><p>' + escapeHTML(name) + ' 的五階建築視覺沙盒</p></div><span class="estate-private">ADMIN EYES ONLY</span></div>' +
    '<div class="estate-stats"><div class="estate-stat"><small>目前階級</small><b data-estate-level>STAGE I</b></div><div class="estate-stat"><small>建築狀態</small><b data-estate-state>展示模式</b></div><div class="estate-stat"><small>結構完整度</small><b class="estate-integrity" data-estate-integrity>100%</b></div></div>' +
    '<div class="estate-actions"><button class="estate-action danger" data-estate-act="missile"><i>▲</i>飛彈試射</button><button class="estate-action danger" data-estate-act="mine"><i>✦</i>地雷測試</button><button class="estate-action" data-estate-act="repair"><i>＋</i>完全修復</button><button class="estate-action" data-estate-act="day"><i>◐</i><span data-estate-day>夜間</span></button></div>' +
    '<div class="estate-tip">拖曳旋轉 · 雙指縮放 · 右鍵平移</div><div class="estate-dock">' + STAGES.map(function (s) { return '<button class="estate-stage" data-estate-stage="' + s.id + '"><strong>' + s.code + '</strong><b>' + s.name + '</b><small>' + s.sub + '</small></button>'; }).join('') + '</div>' +
    '<div class="estate-load"><span class="estate-load-ring"></span><b data-estate-load-title>載入建築模型</b><small data-estate-progress>0%</small></div><div class="estate-toast"></div></div>';
}
function escapeHTML(v) { var d = document.createElement('div'); d.textContent = String(v || ''); return d.innerHTML; }
function q(s) { return E.root && E.root.querySelector(s); }
function toast(text) { var el = q('.estate-toast'); if (!el) return; el.textContent = text; el.classList.add('on'); clearTimeout(E.toastTimer); E.toastTimer = setTimeout(function () { el.classList.remove('on'); }, 1600); }
function updateHUD(stateText) {
  var s = STAGES[E.stage - 1];
  if (q('[data-estate-level]')) q('[data-estate-level]').textContent = 'STAGE ' + s.code;
  if (q('[data-estate-state]')) q('[data-estate-state]').textContent = stateText || '展示模式';
  if (q('[data-estate-integrity]')) q('[data-estate-integrity]').textContent = Math.max(0, Math.round(E.integrity)) + '%';
  E.root.querySelectorAll('[data-estate-stage]').forEach(function (b) { b.classList.toggle('on', Number(b.getAttribute('data-estate-stage')) === E.stage); });
}

function initScene() {
  var canvas = q('canvas'), rect = E.root.getBoundingClientRect();
  E.scene = new T.Scene(); E.scene.background = new T.Color(0x08131e); E.scene.fog = new T.FogExp2(0x08131e, .018);
  E.camera = new T.PerspectiveCamera(42, Math.max(1, rect.width) / Math.max(1, rect.height), .1, 180);
  E.camera.position.set(22, 14, 25);
  E.renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  E.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 1.5)); E.renderer.setSize(rect.width, rect.height, false);
  E.renderer.outputEncoding = T.sRGBEncoding; E.renderer.toneMapping = T.ACESFilmicToneMapping; E.renderer.toneMappingExposure = 1.05;
  E.controls = new T.OrbitControls(E.camera, canvas); E.controls.enableDamping = true; E.controls.dampingFactor = .07; E.controls.target.set(0, 3.3, 0); E.controls.minDistance = 12; E.controls.maxDistance = 53; E.controls.maxPolarAngle = Math.PI * .48; E.controls.enablePan = true;
  E.hemi = new T.HemisphereLight(0x9edfff, 0x24301d, 1.25); E.scene.add(E.hemi);
  E.sun = new T.DirectionalLight(0xffe7c0, 2.5); E.sun.position.set(-12, 22, 10); E.scene.add(E.sun);
  E.loader = new T.GLTFLoader();
  buildCity();
  E.resize = new ResizeObserver(resize); E.resize.observe(E.root);
}
function mat(color, rough, metal) { return new T.MeshStandardMaterial({ color: color, roughness: rough == null ? .82 : rough, metalness: metal || 0 }); }
function mesh(geo, material, x, y, z) { var m = new T.Mesh(geo, material); m.position.set(x || 0, y || 0, z || 0); E.city.add(m); return m; }
function buildCity() {
  E.city = new T.Group(); E.scene.add(E.city);
  var ground = mesh(new T.PlaneGeometry(110, 110), mat(0x17241d, .95), 0, 0, 0); ground.rotation.x = -Math.PI / 2;
  var roadMat = mat(0x111820, .93), road1 = mesh(new T.PlaneGeometry(110, 12), roadMat, 0, .012, 0); road1.rotation.x = -Math.PI / 2;
  var road2 = mesh(new T.PlaneGeometry(12, 110), roadMat, 0, .014, 0); road2.rotation.x = -Math.PI / 2;
  var plot = mesh(new T.CylinderGeometry(10.3, 10.8, .35, 8), mat(0x263026, .9), 0, .17, 0);
  var lineMat = new T.LineBasicMaterial({ color: 0x63ddff, transparent: true, opacity: .55 });
  var pts = [], r = 10.65; for (var i = 0; i <= 8; i++) { var a = Math.PI / 8 + i * Math.PI / 4; pts.push(new T.Vector3(Math.cos(a) * r, .39, Math.sin(a) * r)); }
  E.city.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), lineMat));
  var boxGeo = new T.BoxGeometry(1, 1, 1), cityMat = [mat(0x202d37, .85), mat(0x2b3943, .82), mat(0x172a35, .86)];
  for (var n = 0; n < 34; n++) {
    var side = n % 4, lane = 16 + (n % 3) * 6, offset = -45 + ((n * 13) % 88), x = side < 2 ? offset : (side === 2 ? -lane : lane), z = side < 2 ? (side === 0 ? -lane : lane) : offset;
    if (Math.abs(x) < 13 && Math.abs(z) < 13) continue;
    var h = 2.5 + ((n * 17) % 8), b = mesh(boxGeo, cityMat[n % cityMat.length], x, h / 2, z); b.scale.set(3 + n % 4, h, 3 + (n * 3) % 4);
  }
  var trunkGeo = new T.CylinderGeometry(.12, .16, 1.1, 7), leafGeo = new T.IcosahedronGeometry(.75, 1), trunkMat = mat(0x4c3524, 1), leafMat = mat(0x1f6744, .9);
  [[-13,-13],[13,-13],[-13,13],[13,13],[-19,7],[19,-7]].forEach(function (p) { var tr = mesh(trunkGeo,trunkMat,p[0],.55,p[1]); var lf = mesh(leafGeo,leafMat,p[0],1.65,p[1]); lf.scale.y=1.25; });
  var lampMat = mat(0x4e6470,.45,.35), glowMat = new T.MeshBasicMaterial({color:0xa9efff});
  [[-7,-14],[7,-14],[-7,14],[7,14],[-14,-7],[-14,7],[14,-7],[14,7]].forEach(function(p){ mesh(new T.CylinderGeometry(.055,.08,2.6,6),lampMat,p[0],1.3,p[1]); mesh(new T.SphereGeometry(.14,8,6),glowMat,p[0],2.62,p[1]); });
  var starsGeo = new T.BufferGeometry(), arr = new Float32Array(240 * 3); for (var j=0;j<240;j++){arr[j*3]=(Math.random()-.5)*120;arr[j*3+1]=18+Math.random()*35;arr[j*3+2]=(Math.random()-.5)*120;} starsGeo.setAttribute('position',new T.BufferAttribute(arr,3));
  E.stars = new T.Points(starsGeo,new T.PointsMaterial({color:0xb9e6ff,size:.12,transparent:true,opacity:0})); E.scene.add(E.stars);
}

function disposeObject(obj) {
  if (!obj) return; obj.traverse(function (o) { if (!o.isMesh) return; if (o.geometry) o.geometry.dispose(); var ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(function (m) { if (!m) return; Object.keys(m).forEach(function (k) { if (m[k] && m[k].isTexture) m[k].dispose(); }); m.dispose(); }); });
}
function loadStage(id) {
  E.stage = Math.max(1, Math.min(5, Number(id) || 1)); updateHUD('模型載入中');
  var s = STAGES[E.stage - 1], load = q('.estate-load'), pct = q('[data-estate-progress]'), title = q('[data-estate-load-title]'), token = ++E.token;
  load.hidden = false; title.textContent = s.name; pct.textContent = '0%';
  E.loader.load(s.file, function (gltf) {
    if (token !== E.token || E.disposed) { disposeObject(gltf.scene); return; }
    if (E.model) { E.scene.remove(E.model); disposeObject(E.model); }
    var model = gltf.scene, box = new T.Box3().setFromObject(model), size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3()), max = Math.max(size.x,size.y,size.z) || 1, scale = s.scale / max;
    model.scale.setScalar(scale); model.updateMatrixWorld(true); box.setFromObject(model); center = box.getCenter(new T.Vector3());
    model.position.set(-center.x, .38 - box.min.y, -center.z); model.rotation.y = Math.PI * .05;
    model.traverse(function (o) { if (!o.isMesh) return; o.castShadow = false; o.receiveShadow = false; var ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(function(m){if(m&&m.map){m.map.anisotropy=4;m.needsUpdate=true;}}); });
    model.userData.reveal = 0; model.userData.finalScale = model.scale.x; model.scale.setScalar(model.scale.x * .72);
    E.model = model; E.scene.add(model); load.hidden = true; updateHUD('展示模式'); toast(s.name + ' 已進入領地');
  }, function (x) { if (token === E.token && x.total) pct.textContent = Math.min(99,Math.round(x.loaded/x.total*100)) + '%'; }, function () { if(token!==E.token)return; title.textContent='模型載入失敗';pct.textContent='請重新選擇階級';updateHUD('載入失敗'); });
}
function resize() { if (!E.root || !E.renderer) return; var r=E.root.getBoundingClientRect(); if(!r.width||!r.height)return; E.camera.aspect=r.width/r.height;E.camera.updateProjectionMatrix();E.renderer.setSize(r.width,r.height,false); }
function setIntegrity(v, status) { E.integrity=Math.max(0,Math.min(100,v));updateHUD(status); }
function ringAt(pos,color,maxScale,duration) { var g=new T.RingGeometry(.25,.38,32),m=new T.MeshBasicMaterial({color:color,transparent:true,opacity:.9,side:T.DoubleSide,depthWrite:false}),o=new T.Mesh(g,m);o.rotation.x=-Math.PI/2;o.position.copy(pos);o.position.y=.48;E.scene.add(o);E.fx.push({obj:o,start:performance.now(),duration:duration||850,update:function(t){o.scale.setScalar(1+(maxScale||8)*t);m.opacity=1-t;}}); }
function explosion(pos, damage, label) {
  ringAt(pos,0xff5d78,7,700); var group=new T.Group(), geo=new T.IcosahedronGeometry(.12,0),m=new T.MeshBasicMaterial({color:0xffa14e});
  for(var i=0;i<30;i++){var p=new T.Mesh(geo,m.clone());p.position.copy(pos);p.userData.v=new T.Vector3((Math.random()-.5)*7,Math.random()*5,(Math.random()-.5)*7);group.add(p);} E.scene.add(group);
  E.fx.push({obj:group,start:performance.now(),duration:900,update:function(t,dt){group.children.forEach(function(p){p.position.addScaledVector(p.userData.v,dt);p.userData.v.y-=8*dt;p.material.opacity=1-t;p.material.transparent=true;});}});
  setIntegrity(E.integrity-damage,label); toast(label+'・完整度 -'+damage+'%');
}
function missile() {
  if(!E.scene)return; var g=new T.Group(),body=new T.Mesh(new T.CylinderGeometry(.13,.16,1.15,10),mat(0x8b9499,.35,.7)),tip=new T.Mesh(new T.ConeGeometry(.16,.35,10),mat(0xff526f,.3,.25));body.rotation.x=Math.PI/2;tip.rotation.x=Math.PI/2;tip.position.z=-.74;g.add(body,tip);g.position.set(-22,11,18);E.scene.add(g);
  var start=performance.now(),from=g.position.clone(),target=new T.Vector3(0,.8,0); E.fx.push({obj:g,start:start,duration:1450,update:function(t){var p=from.clone().lerp(target,t);p.y+=Math.sin(Math.PI*t)*6;g.position.copy(p);var nt=Math.min(1,t+.02),np=from.clone().lerp(target,nt);np.y+=Math.sin(Math.PI*nt)*6;g.lookAt(np);},done:function(){explosion(target,25,'飛彈命中');}}); updateHUD('警報：來襲');
}
function mine() {
  var pos=new T.Vector3((Math.random()-.5)*8,.55,(Math.random()-.5)*8),g=new T.Group(),base=new T.Mesh(new T.CylinderGeometry(.48,.55,.22,12),mat(0x29353b,.45,.6)),core=new T.Mesh(new T.SphereGeometry(.16,10,8),new T.MeshBasicMaterial({color:0xff315d}));core.position.y=.17;g.add(base,core);g.position.copy(pos);E.scene.add(g);toast('地雷已埋設');updateHUD('地雷倒數');
  var timer=setTimeout(function(){if(E.disposed)return;E.scene.remove(g);disposeObject(g);explosion(pos,12,'地雷引爆');},1200);E.timers.push(timer);
}
function repair() { setIntegrity(100,'結構修復完成');ringAt(new T.Vector3(0,.4,0),0x65e6ff,12,1100);toast('領地結構已完全修復'); }
function toggleDay() { E.night=!E.night; q('[data-estate-day]').textContent=E.night?'日間':'夜間';toast(E.night?'已切換為夜間巡視':'已切換為日間巡視'); }
function updateLight(dt) { var n=E.night?1:0;E.dayMix+=(n-E.dayMix)*Math.min(1,dt*2.3);var d=E.dayMix;E.scene.background.setRGB(.03*(1-d)+.006*d,.075*(1-d)+.012*d,.115*(1-d)+.035*d);E.scene.fog.color.copy(E.scene.background);E.hemi.intensity=1.25*(1-d)+.32*d;E.sun.intensity=2.5*(1-d)+.18*d;E.stars.material.opacity=d*.9;E.renderer.toneMappingExposure=1.05*(1-d)+.72*d; }
function frame(now) {
  if(!E.active||E.disposed)return;E.raf=requestAnimationFrame(frame);var dt=Math.min(.05,(now-(E.last||now))/1000);E.last=now;E.controls.update();updateLight(dt);
  if(E.model&&E.model.userData.reveal<1){E.model.userData.reveal=Math.min(1,E.model.userData.reveal+dt*1.8);var r=E.model.userData.reveal,k=.72+.28*(1-Math.pow(1-r,3));E.model.scale.setScalar(E.model.userData.finalScale*k);}
  for(var i=E.fx.length-1;i>=0;i--){var f=E.fx[i],t=Math.min(1,(now-f.start)/f.duration);f.update(t,dt);if(t>=1){E.scene.remove(f.obj);disposeObject(f.obj);if(f.done)f.done();E.fx.splice(i,1);}}
  E.renderer.render(E.scene,E.camera);
}
function bind() {
  E.root.querySelectorAll('[data-estate-stage]').forEach(function(b){b.onclick=function(){loadStage(b.getAttribute('data-estate-stage'));};});
  E.root.querySelectorAll('[data-estate-act]').forEach(function(b){b.onclick=function(){var a=b.getAttribute('data-estate-act');if(a==='missile')missile();else if(a==='mine')mine();else if(a==='repair')repair();else toggleDay();};});
}
function mount(root,ctx) {
  if(!root)return;if(E.root===root&&!E.disposed){E.ctx=ctx;setActive(true);return;}unmount();addStyle();E.root=root;E.ctx=ctx;E.disposed=false;E.active=true;E.integrity=100;E.stage=1;E.night=false;E.dayMix=0;root.innerHTML=markup(ctx);bind();initScene();updateHUD();loadStage(1);E.last=performance.now();E.raf=requestAnimationFrame(frame);
}
function setActive(active){E.active=!!active;if(E.active&&!E.disposed&&!E.raf){E.last=performance.now();E.raf=requestAnimationFrame(frame);}if(!E.active&&E.raf){cancelAnimationFrame(E.raf);E.raf=0;}}
function unmount(){E.disposed=true;E.active=false;++E.token;if(E.raf)cancelAnimationFrame(E.raf);E.raf=0;E.timers.splice(0).forEach(clearTimeout);if(E.resize)E.resize.disconnect();if(E.controls)E.controls.dispose();if(E.scene)disposeObject(E.scene);if(E.renderer)E.renderer.dispose();if(E.root)E.root.innerHTML='';E.root=null;E.scene=null;E.model=null;E.fx=[];}

global.EstateApp={mount:mount,setActive:setActive,unmount:unmount,stages:STAGES};
})(window);

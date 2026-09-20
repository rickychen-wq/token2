(function(){
'use strict';
var FX=window.TokenFX=window.TokenFX||{};
var REDUCE=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches);
function q(s,r){return (r||document).querySelector(s)}
function qa(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function num(v){return Number(v)||0}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function easeOutCubic(t){return 1-Math.pow(1-t,3)}
function easeInOut(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2}
function rel(el,root){var a=el.getBoundingClientRect(),b=root.getBoundingClientRect();return{x:a.left-b.left+a.width/2,y:a.top-b.top+a.height/2,w:a.width,h:a.height}}
function layer(root){var x=q(':scope>.tfx-layer',root);if(!x){x=document.createElement('div');x.className='tfx-layer';root.appendChild(x)}return x}
function fmt(n){return Math.round(n).toLocaleString('en-US')}

/* ---------------- CANVAS DICE RENDERER ---------------- */
var diceState=null;
var FACE_DATA=[
 {n:[0,0,1],v:[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],value:1},
 {n:[0,0,-1],v:[[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]],value:6},
 {n:[1,0,0],v:[[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]],value:3},
 {n:[-1,0,0],v:[[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]],value:4},
 {n:[0,-1,0],v:[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]],value:2},
 {n:[0,1,0],v:[[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]],value:5}
];
var PIPS={1:[[0,0]],2:[[-.43,-.43],[.43,.43]],3:[[-.43,-.43],[0,0],[.43,.43]],4:[[-.43,-.43],[.43,-.43],[-.43,.43],[.43,.43]],5:[[-.43,-.43],[.43,-.43],[0,0],[-.43,.43],[.43,.43]],6:[[-.43,-.48],[.43,-.48],[-.43,0],[.43,0],[-.43,.48],[.43,.48]]};
function rotPoint(p,r){var x=p[0],y=p[1],z=p[2],cx=Math.cos(r.x),sx=Math.sin(r.x),cy=Math.cos(r.y),sy=Math.sin(r.y),cz=Math.cos(r.z),sz=Math.sin(r.z);var y1=y*cx-z*sx,z1=y*sx+z*cx;var x2=x*cy+z1*sy,z2=-x*sy+z1*cy;var x3=x2*cz-y1*sz,y3=x2*sz+y1*cz;return[x3,y3,z2]}
function rotVec(p,r){return rotPoint(p,r)}
function proj(p,die,cam){var z=p[2]*die.size+die.z,sc=cam/(cam-z);return{x:die.x+p[0]*die.size*sc,y:die.y+p[1]*die.size*sc,z:z,s:sc}}
function faceLocalPoint(face,u,v){var c=[0,0,0],a=face.v[0],b=face.v[1],d=face.v[3];for(var i=0;i<3;i++){var ab=(b[i]-a[i])*.5,ad=(d[i]-a[i])*.5;c[i]=(a[i]+b[i]+d[i]+face.v[2][i])*.25+ab*u+ad*v}return c}
function targetRot(value,spinZ){var map={1:[0,0],6:[0,Math.PI],3:[0,-Math.PI/2],4:[0,Math.PI/2],2:[-Math.PI/2,0],5:[Math.PI/2,0]},m=map[value]||map[1];return{x:m[0]+.12,y:m[1]-.10,z:spinZ||0}}
function drawDie(ctx,die,w,h){
 var cam=520,faces=[];
 FACE_DATA.forEach(function(f){var nn=rotVec(f.n,die.r);if(nn[2]<=.035)return;var pts=f.v.map(function(v){return proj(rotPoint(v,die.r),die,cam)});faces.push({f:f,n:nn,pts:pts,depth:pts.reduce(function(a,p){return a+p.z},0)/4})});
 faces.sort(function(a,b){return a.depth-b.depth});
 faces.forEach(function(o){var pts=o.pts;ctx.save();ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(var i=1;i<4;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.closePath();var minX=Math.min.apply(null,pts.map(function(p){return p.x})),maxX=Math.max.apply(null,pts.map(function(p){return p.x})),minY=Math.min.apply(null,pts.map(function(p){return p.y})),maxY=Math.max.apply(null,pts.map(function(p){return p.y}));var g=ctx.createLinearGradient(minX,minY,maxX,maxY);g.addColorStop(0,'rgba(244,253,255,.88)');g.addColorStop(.22,'rgba(185,235,255,.66)');g.addColorStop(.72,'rgba(83,160,206,.50)');g.addColorStop(1,'rgba(28,75,111,.62)');ctx.fillStyle=g;ctx.shadowColor='rgba(64,199,255,.12)';ctx.shadowBlur=10;ctx.fill();ctx.shadowBlur=0;ctx.lineWidth=1.15;ctx.strokeStyle='rgba(225,250,255,.82)';ctx.stroke();
 // glass highlight, clipped to the visible face only
 ctx.clip();var hg=ctx.createLinearGradient(minX,minY,maxX,minY);hg.addColorStop(0,'rgba(255,255,255,.34)');hg.addColorStop(.34,'rgba(255,255,255,.04)');hg.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=hg;ctx.fillRect(minX,minY,(maxX-minX)*.5,maxY-minY);ctx.restore();
 // flat luminous pips: printed on the face, never bead-like or raised
 var pips=PIPS[o.f.value]||[];ctx.save();ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(var pi=1;pi<4;pi++)ctx.lineTo(pts[pi].x,pts[pi].y);ctx.closePath();ctx.clip();pips.forEach(function(pv){var lp=faceLocalPoint(o.f,pv[0],pv[1]),wp=rotPoint(lp,die.r),sp=proj(wp,die,cam),rad=clamp(3.45*sp.s,2.05,4.25);ctx.save();ctx.beginPath();ctx.arc(sp.x,sp.y,rad,0,Math.PI*2);ctx.fillStyle='rgba(155,236,255,.98)';ctx.shadowColor='rgba(83,216,255,.68)';ctx.shadowBlur=5;ctx.fill();ctx.restore()});ctx.restore();
 });
}
function drawDiceScene(state){var c=state.canvas,ctx=state.ctx,dpr=state.dpr,w=state.w,h=state.h;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);state.dice.forEach(function(d){var sw=d.size*1.85*(520/(520-d.z));ctx.save();ctx.translate(d.x,d.ground+29);ctx.scale(1,.24);var rg=ctx.createRadialGradient(0,0,2,0,0,sw);rg.addColorStop(0,'rgba(0,0,0,.40)');rg.addColorStop(.65,'rgba(0,0,0,.17)');rg.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=rg;ctx.beginPath();ctx.arc(0,0,sw,0,Math.PI*2);ctx.fill();ctx.restore()});state.dice.forEach(function(d){drawDie(ctx,d,w,h)})}
function resizeDice(state){var r=state.tray.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);state.w=Math.max(1,r.width);state.h=Math.max(1,r.height);state.dpr=dpr;state.canvas.width=Math.round(state.w*dpr);state.canvas.height=Math.round(state.h*dpr);state.canvas.style.width=state.w+'px';state.canvas.style.height=state.h+'px'}
function clearDice(state){if(!state)return;if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;if(state.tray){state.tray.classList.remove('tfx-dice-active');if(state.tray._tfxDice===state)delete state.tray._tfxDice}if(state.canvas&&state.canvas.parentNode)state.canvas.remove();if(diceState===state)diceState=null}
FX.cancelDice=function(){clearDice(diceState)};
window.addEventListener('resize',FX.cancelDice);
function makeDiceState(tray,values){FX.cancelDice();var canvas=q(':scope>.tfx-dice-canvas',tray);if(!canvas){canvas=document.createElement('canvas');canvas.className='tfx-dice-canvas';tray.appendChild(canvas)}var state={tray:tray,canvas:canvas,ctx:canvas.getContext('2d'),values:values,dice:[],start:performance.now(),phase:'roll',raf:0};resizeDice(state);var w=state.w,h=state.h,baseSize=clamp(w*.072,24,31),spread=clamp(w*.18,64,105);for(var i=0;i<3;i++){var finalX=w/2+(i-1)*spread+(i===0?-8:i===2?9:0),ground=h*.57+(i===1?7:0);state.dice.push({x:finalX+(i-1)*7,y:h*.25+i*3,z:10,ground:ground,size:baseSize,vx:(i-1)*22+(i===1?8:0),vy:-110-i*16,r:{x:.4+i*.7,y:.7+i*.4,z:i*.45},rv:{x:6.4+i*.9,y:8.1-i*.55,z:5.2+i*.6},value:values[i],target:null,settleStart:0})}tray._tfxDice=state;tray.classList.add('tfx-dice-active');diceState=state;return state}
FX.rollDice=function(tray,values){if(REDUCE)return;if(typeof tray==='string')tray=q(tray);if(!tray||!Array.isArray(values)||values.length!==3||values.some(function(v){return !Number.isInteger(v)||v<1||v>6}))return;values=values.slice();var s=makeDiceState(tray,values),last=s.start;
 function frame(now){var dt=Math.min(.028,(now-last)/1000||.016),elapsed=(now-s.start)/1000;last=now;if(s.phase==='roll'){
   if(diceState!==s||!s.canvas.isConnected){clearDice(s);return}
   s.dice.forEach(function(d,i){d.vy+=760*dt;d.x+=d.vx*dt;d.y+=d.vy*dt;d.r.x+=d.rv.x*dt;d.r.y+=d.rv.y*dt;d.r.z+=d.rv.z*dt;if(d.y>d.ground){d.y=d.ground;d.vy=-Math.abs(d.vy)*(.34-i*.025);d.vx*=.78;d.rv.x*=.75;d.rv.y*=.78;d.rv.z*=.72}d.z=8+Math.max(0,(d.ground-d.y)*.13)});
   if(elapsed>1.22){s.phase='settle';s.dice.forEach(function(d,i){d.settleStart=now;d.from={x:d.x,y:d.y,z:d.z,rx:d.r.x,ry:d.r.y,rz:d.r.z};d.to={x:d.x+clamp(d.vx*.035,-7,7),y:d.ground,z:7,rot:targetRot(d.value,d.r.z%(Math.PI*2))}})}
 }else if(s.phase==='settle'){
   var all=true;s.dice.forEach(function(d){var t=clamp((now-d.settleStart)/650,0,1),e=easeOutCubic(t);d.x=d.from.x+(d.to.x-d.from.x)*e;d.y=d.from.y+(d.to.y-d.from.y)*e;d.z=d.from.z+(d.to.z-d.from.z)*e;d.r.x=d.from.rx+(d.to.rot.x-d.from.rx)*e;d.r.y=d.from.ry+(d.to.rot.y-d.from.ry)*e;d.r.z=d.from.rz+(d.to.rot.z-d.from.rz)*e;if(t<1)all=false});if(all)s.phase='done'
 }
 drawDiceScene(s);if(s.phase!=='done'){s.raf=requestAnimationFrame(frame)}else{s.raf=0}
 }s.raf=requestAnimationFrame(frame)
};

/* ---------------- CARD DEAL ---------------- */
function flyCard(felt,target,delay){if(!target)return;var l=layer(felt),fr=felt.getBoundingClientRect(),to=rel(target,felt),tr=target.getBoundingClientRect(),w=tr.width||24,h=tr.height||34,c=target.cloneNode(true);c.removeAttribute('id');c.classList.add('tfx-fly-card');c.classList.remove('tfx-card-land');var sx=fr.width*.5-w/2,sy=fr.height*.44-h/2;c.style.left=sx+'px';c.style.top=sy+'px';c.style.width=w+'px';c.style.height=h+'px';target.classList.add('tfx-arriving');l.appendChild(c);var dx=to.x-fr.width*.5,dy=to.y-fr.height*.44;setTimeout(function(){var a=c.animate([{transform:'translate3d(0,0,0) rotateZ(-9deg) rotateY(22deg) scale(.86)',opacity:.55},{offset:.58,transform:'translate3d('+(dx*.58)+'px,'+(dy*.58-14)+'px,0) rotateZ(5deg) rotateY(-8deg) scale(1.04)',opacity:1},{transform:'translate3d('+dx+'px,'+dy+'px,0) rotateZ(0) rotateY(0) scale(1)',opacity:1}],{duration:430,easing:'cubic-bezier(.16,.78,.2,1)',fill:'forwards'});a.onfinish=function(){c.remove();target.classList.remove('tfx-arriving');target.classList.add('tfx-card-land');setTimeout(function(){target.classList.remove('tfx-card-land')},260)}} ,delay)}
FX.deal=function(felt,targets){if(REDUCE)return;if(typeof felt==='string')felt=q(felt);if(!felt)return;qa('.tfx-fly-card',felt).forEach(function(x){x.remove()});qa('.tfx-arriving,.tfx-card-land',felt).forEach(function(x){x.classList.remove('tfx-arriving','tfx-card-land')});(targets||[]).forEach(function(t,i){if(typeof t==='string')t=q(t,felt)||q(t);flyCard(felt,t,i*92)})};

/* ---------------- CHIP FLOW ---------------- */
function chipMove(felt,from,to,count,delay,arrive){var l=layer(felt),a=rel(from,felt),b=rel(to,felt);for(var i=0;i<count;i++){(function(i){setTimeout(function(){var c=document.createElement('i');c.className='tfx-chip';c.style.left=(a.x-12.5)+'px';c.style.top=(a.y-12.5)+'px';l.appendChild(c);var dx=b.x-a.x+(i-(count-1)/2)*8,dy=b.y-a.y,arc=18+i*3;var an=c.animate([{transform:'translate3d(0,0,0) rotate(0deg) scale(.78)',opacity:.35},{offset:.46,transform:'translate3d('+(dx*.47)+'px,'+(dy*.47-arc)+'px,0) rotate('+(95+i*28)+'deg) scale(1.12)',opacity:1},{offset:.84,transform:'translate3d('+(dx*.88)+'px,'+(dy*.88-3)+'px,0) rotate('+(210+i*34)+'deg) scale(1)',opacity:1},{transform:'translate3d('+dx+'px,'+dy+'px,0) rotate('+(280+i*42)+'deg) scale(.9)',opacity:.92}],{duration:520+i*32,easing:'cubic-bezier(.16,.76,.2,1)',fill:'forwards'});an.onfinish=function(){c.remove();if(i===count-1&&arrive)arrive()}},i*48+(delay||0))})(i)}}
FX.tokensToPot=function(felt,froms,pot){if(REDUCE)return;if(typeof felt==='string')felt=q(felt);if(typeof pot==='string')pot=q(pot);if(!felt||!pot)return;(froms||[]).forEach(function(f,i){if(typeof f==='string')f=q(f);if(f)chipMove(felt,f,pot,2,i*120,function(){pot.classList.add('tfx-pot-pulse');setTimeout(function(){pot.classList.remove('tfx-pot-pulse')},360)})})};
function animateNumber(el,from,to,dur){var s=performance.now();function tick(n){var t=clamp((n-s)/dur,0,1),e=easeInOut(t);el.textContent=fmt(from+(to-from)*e);if(t<1)requestAnimationFrame(tick);else el.textContent=fmt(to)}requestAnimationFrame(tick)}
function stackOverlay(felt,stack,amount){if(!stack)return;var finalValue=num(String(stack.textContent||'').replace(/,/g,'')),l=layer(felt),p=rel(stack,felt),o=document.createElement('div');o.className='tfx-stack-overlay tfx-stack-pop';o.style.left=(p.x-p.w/2)+'px';o.style.top=(p.y-p.h/2)+'px';o.style.width=p.w+'px';o.style.height=p.h+'px';l.appendChild(o);animateNumber(o,Math.max(0,finalValue-amount),finalValue,620);setTimeout(function(){o.remove()},680)}
FX.potToWinner=function(felt,pot,winner,amount){if(REDUCE)return;if(typeof felt==='string')felt=q(felt);if(typeof pot==='string')pot=q(pot);if(typeof winner==='string')winner=q(winner);amount=num(amount);if(!felt||!pot||!winner||amount<=0)return;var stack=q('.stk',winner);chipMove(felt,pot,winner,7,0,function(){winner.classList.add('tfx-winner-glow');stackOverlay(felt,stack,amount);var l=layer(felt),p=rel(winner,felt),g=document.createElement('div');g.className='tfx-float-gain';g.textContent='+'+fmt(amount);g.style.left=p.x+'px';g.style.top=(p.y-35)+'px';l.appendChild(g);setTimeout(function(){g.remove();winner.classList.remove('tfx-winner-glow')},780)})};
FX.version='final-1.2-printed-pips';
})();

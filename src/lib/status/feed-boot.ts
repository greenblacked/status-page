import { PULSE_STORAGE_KEY } from "./pulse.ts";
import { RECENT_LIMIT } from "./recent.ts";
import { PULSE_INTERVAL_MS } from "./schedule.ts";

/** The custom property on <html> that holds the height, in px, Recent changes will draw once the saved checks load. */
export const FEED_RESERVE_PROPERTY = "--feed-reserve";

/**
 * What the boot script knows of the layout, in CSS px at the default 16px
 * root size. Each number is copied from the markup or styles it stands for
 * (update-feed.tsx, board-view.tsx, styles.css); feed-boot.test.ts holds the
 * script to them. The text widths are a little narrow on purpose, so a
 * row is guessed a line short rather than a line long: a reserve that is too
 * tall shrinks when the checks arrive, and a shrink moves the board as much
 * as a growth.
 */
export const FEED_METRICS = {
  /** `min-width: 48rem`: the margin column appears, and the gutter widens. */
  wide: 768,
  /** `max-w-[62rem]` on the board body, gutters included. */
  maxBody: 992,
  /** `--gutter` below and above `wide`. */
  gutter: 16,
  gutterWide: 32,
  /** `--margin-col` and the grid's `column-gap` (`board-grid`). */
  margin: 200,
  gap: 32,
  /** What sits beside a row's text: the surface's border, `px-4` twice, the 5.5rem time column and `gap-3`. */
  beside: 2 + 32 + 88 + 12,
  /** The surface's border, top and bottom. */
  border: 2,
  /** A row's `py-3`, top and bottom. */
  pad: 24,
  /** The text-body line (title) and the text-caption line. */
  titleLine: 21,
  captionLine: 18,
  /** The title is `text-body` (15px) and the caption `text-caption` (13px). */
  titleSize: 15,
  captionSize: 13,
  /**
   * Arial's advance widths in 1/1000 em for a to z and A to Z; every other
   * character is guessed in the script. Inter is drawn at about `scale` times
   * these, measured in Chromium; Inter Fallback is Arial at 107.4%, so this
   * errs narrow, and a row is guessed a line short rather than a line long.
   */
  lower: [
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
    500, 500, 500,
  ],
  upper: [
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611,
  ],
  scale: 1.03,
} as const;

/**
 * Runs in <head> before the body paints. The saved checks live in local
 * storage, so the server (and the first client render) draws Recent changes
 * empty, and it would grow by up to eight rows after hydration and push the
 * board below it down. This works out how tall those rows will be, from the
 * same key and the same words `recentRows` writes (a faithful copy of its
 * text, held to it by feed-boot.test.ts): the first RECENT_LIMIT checks, a
 * run of checks with no change being one row, each row's title and caption
 * wrapped by Arial's character widths in the width of the feed's column,
 * which follows from the window width and the layout's breakpoints. The load
 * itself adds a check unless this two-minute slot is already saved, and it
 * pushes the oldest one out, so the script puts a quiet one first (a quiet
 * check is the usual one; a change would only make the row taller). The
 * empty state reserves that height in px (update-feed.tsx). A row that wraps
 * on a phone is several lines, so a count of rows alone fell far short there.
 * Any failure leaves the property unset, which reads as 0. Inline, which the
 * page's Content-Security-Policy allows ('unsafe-inline' in script-src).
 */
export const FEED_BOOT_SCRIPT = `
try{
var M=${JSON.stringify(FEED_METRICS)};
var z=JSON.parse(localStorage.getItem(${JSON.stringify(PULSE_STORAGE_KEY)})),p=z.pulses;
if(Array.isArray(p)){
if(!(p.length>0&&z.lastSlot===Math.floor(Date.now()/${PULSE_INTERVAL_MS})*${PULSE_INTERVAL_MS}))p=[{changes:[]}].concat(p);
var w=window.innerWidth,wide=w>=M.wide;
var c=Math.min(w,M.maxBody)-2*(wide?M.gutterWide:M.gutter)-(wide?M.margin+M.gap:0)-M.beside;
c=Math.max(c,60);
var G=function(s,f){
var t=0,i,k;
for(i=0;i<s.length;i++){
k=s.charCodeAt(i);
t+=k>=97&&k<=122?M.lower[k-97]:k>=65&&k<=90?M.upper[k-65]:k===32||k===46||k===44||k===58||k===59||k===47||k===124?278:k===45||k===40||k===41||k===183?333:556;
}
return t*f*M.scale/1000};
var L=function(s,f){
var n=1,u=0,sp=G(" ",f),a=String(s).split(" "),i,g;
for(i=0;i<a.length;i++){
g=G(a[i],f);
if(u>0&&u+sp+g<=c){u+=sp+g}else{if(u>0)n++;u=g}
if(u>c){n+=Math.ceil(u/c)-1;u=u%c||c}
}
return n};
var N=function(o){return o&&typeof o.name==="string"?o.name:""};
var R=[],h=M.border,q=false,j,x,e,t,d,o,s,m;
p=p.slice(0,${RECENT_LIMIT});
for(j=0;j<p.length;j++){
x=p[j];
e=!!x&&!x.opening&&Array.isArray(x.changes)&&x.changes.length===0;
if(e&&q){
o=R[R.length-1];
o[2]++;
o[0]="Nothing changed \\u00b7 "+o[2]+" checks";
continue;
}
q=e;t="";d="";
if(x&&typeof x==="object"){
o=x.counts&&typeof x.counts==="object"?x.counts:{};
s=0;
for(m in o)s+=Number(o[m])||0;
d=(Number(o.operational)||0)+" of "+s+" up";
if(x.opening)t="First check";
else if(e)t="Nothing changed";
else if(Array.isArray(x.changes)){
if(x.changes.length===1){
o=x.changes[0]||{};
if(o.from===o.to)t=N(o)+": "+o.summary;
else{
t=o.to==="operational"?N(o)+" is back":o.to==="degraded"?N(o)+" is now degraded":o.to==="outage"?N(o)+" is now down":o.to==="maintenance"?N(o)+" is now in maintenance":"Couldn't read "+N(o);
if(o.summary)d+=" \\u00b7 "+o.summary;
}
}else{
t=x.changes.length+" services changed";
d+=" \\u00b7 "+x.changes.map(N).join(", ");
}
}
}
R.push([t,d,1]);
}
for(j=0;j<R.length;j++)h+=M.pad+M.titleLine*L(R[j][0],M.titleSize)+M.captionLine*L(R[j][1],M.captionSize);
if(R.length>0)document.documentElement.style.setProperty(${JSON.stringify(FEED_RESERVE_PROPERTY)},h+"px");
}
}catch(e){}
`.replace(/\n/g, "");

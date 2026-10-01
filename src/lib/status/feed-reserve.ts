import { PULSE_STORAGE_KEY } from "./pulse.ts";
import { RECENT_LIMIT } from "./recent.ts";
import { PULSE_INTERVAL_MS } from "./schedule.ts";

/** The custom property on the feed's surface that holds the height, in px, the saved checks will fill. */
export const FEED_RESERVE_PROPERTY = "--feed-reserve";

/**
 * The classes of one row of Recent changes. UpdateFeed draws its rows with
 * them and the reserve script builds its measuring rows with them, so the
 * two cannot drift apart in how they are laid out.
 */
export const FEED_ROW_CLASSES = {
  row: "row grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 px-4 py-3",
  time: "pt-px text-footnote text-muted",
  body: "min-w-0",
  title: "text-body text-fg [overflow-wrap:anywhere]",
  caption: "text-caption text-subtle [overflow-wrap:anywhere]",
} as const;

/**
 * Sits in the server's markup right after the feed's surface, so it runs
 * while the page is parsed, before the first paint. The saved checks live in
 * local storage, so the server (and the first client render) draws Recent
 * changes empty, and it would grow by up to eight rows after hydration and
 * push the board below it down. The script builds the rows `recentRows` will
 * write, from the same key, as real DOM with the classes UpdateFeed uses
 * (FEED_ROW_CLASSES), puts them in a copy of the surface right next to it so
 * they are laid out at the real width, font and root size, reads their
 * height and removes them again in the same task, so nothing of it paints.
 * The height goes to the surface as `--feed-reserve`, which its empty state
 * reads (update-feed.tsx). It measures once at once and again when the fonts
 * the page is loading are in, since the text is laid out in a stand-in
 * face until then, and stops if the rows have been drawn meanwhile.
 *
 * Measuring in place replaces an estimate from the window width and a table of
 * character widths, which fell short at a larger default font size and on
 * Apple's system font. Its one guess is structural: the load itself adds a
 * check unless this two-minute slot is already saved, and pushes the oldest
 * one out. The script puts a quiet one first, with the newest saved check's counts, the usual outcome; a check that
 * found changes is taller, and the reserve is then short by the difference.
 *
 * The wording of the rows is a copy of `recentRows` (feed-reserve.test.ts
 * holds it to the real thing). It never throws: any failure leaves the
 * property unset, which reads as 0. Inline, which the page's
 * Content-Security-Policy allows ('unsafe-inline' in script-src).
 */
export const FEED_RESERVE_SCRIPT = `
(function(){
try{
var s=document.currentScript,f=s&&s.previousElementSibling;
if(!f)return;
var z=JSON.parse(localStorage.getItem(${JSON.stringify(PULSE_STORAGE_KEY)})),p=z.pulses;
if(!Array.isArray(p))return;
if(!(p.length>0&&z.lastSlot===Math.floor(Date.now()/${PULSE_INTERVAL_MS})*${PULSE_INTERVAL_MS}))p=[{changes:[],counts:p[0]&&p[0].counts}].concat(p);
p=p.slice(0,${RECENT_LIMIT});
var E=function(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n};
var N=function(o){return o&&typeof o.name==="string"?o.name:""};
var ol=E("ol"),last=null,j,x,e,t,d,o,u,m;
for(j=0;j<p.length;j++){
x=p[j];
e=!!x&&!x.opening&&Array.isArray(x.changes)&&x.changes.length===0;
if(e&&last&&last[2]){
last[1]++;
last[0].textContent="Nothing changed \\u00b7 "+last[1]+" checks";
continue;
}
t="";d="";
if(x&&typeof x==="object"){
o=x.counts&&typeof x.counts==="object"?x.counts:{};
u=0;
for(m in o)u+=Number(o[m])||0;
d=(Number(o.operational)||0)+" of "+u+" up";
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
var li=E("li"),r=E("div",${JSON.stringify(FEED_ROW_CLASSES.row)}),b=E("div",${JSON.stringify(FEED_ROW_CLASSES.body)}),ti=E("p",${JSON.stringify(FEED_ROW_CLASSES.title)},t);
b.appendChild(ti);
b.appendChild(E("p",${JSON.stringify(FEED_ROW_CLASSES.caption)},d));
r.appendChild(E("time",${JSON.stringify(`tabular-nums ${FEED_ROW_CLASSES.time}`)},"00:00 UTC"));
r.appendChild(b);
li.appendChild(r);
ol.appendChild(li);
last=[ti,1,e];
}
var W=function(){
try{
if(f.querySelector("ol"))return;
var g=E("div",f.className),h=0;
g.appendChild(ol);
f.parentNode.insertBefore(g,f.nextSibling);
try{h=g.offsetHeight}finally{f.parentNode.removeChild(g)}
if(h>0)f.style.setProperty(${JSON.stringify(FEED_RESERVE_PROPERTY)},h+"px");
}catch(e){}
};
W();
var F=document.fonts;
if(F){
if(F.addEventListener)F.addEventListener("loadingdone",W);
if(F.ready&&F.ready.then)F.ready.then(W,function(){});
}
}catch(e){}
})();
`.replace(/\n/g, "");

// Bounded, data-only approach candidates derived from the CURRENT baseSpec.
// No fixture reads, solver substitutes, parameter changes, or production imports.
const copy = value => structuredClone(value);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const smooth = t => t*t*t*(10+t*(-15+6*t));
const g = 9.81;

export function requiredForce(points, spec) {
  let maximum = 0;
  for (let i=1;i<points.length-1;i++) {
    const [a,b,c]=points.slice(i-1,i+2),v2=spec.entry_speed_ms**2-2*g*(b.y-points[0].y);
    if(v2<=0)return Infinity;
    const ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y),ca=Math.hypot(a.x-c.x,a.y-c.y);
    const area=Math.abs((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y));
    const radius=area<1e-9?Infinity:ab*bc*ca/(2*area);
    maximum=Math.max(maximum,spec.car_mass_kg*v2/radius);
  }
  return maximum;
}

export function roadClearance(points, wall) {
  // The visual deck is 0.28 m thick along its normal. Expand the wall slab
  // horizontally by that amount, then require its source road top >= wall+0.5.
  // This is a conservative road-surface guard, not a truss or structural solver.
  const left=wall.x-(wall.thickness??.35)/2-.28,right=wall.x+(wall.thickness??.35)/2+.28;
  let minimum=Infinity;
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],dx=b.x-a.x;
    if(Math.max(a.x,b.x)<left||Math.min(a.x,b.x)>right)continue;
    if(Math.abs(dx)<1e-12){minimum=Math.min(minimum,a.y,b.y);continue;}
    const ta=Math.max(0,Math.min((left-a.x)/dx,(right-a.x)/dx)),tb=Math.min(1,Math.max((left-a.x)/dx,(right-a.x)/dx));
    if(ta<=tb)minimum=Math.min(minimum,a.y+(b.y-a.y)*ta,a.y+(b.y-a.y)*tb);
  }
  return {clear:minimum>=wall.height+.5,minimumRoadYM:Number.isFinite(minimum)?minimum:null,requiredRoadYM:wall.height+.5,horizontalDeckPaddingM:.28};
}

function generateApproachCandidates(baseSpec, wall) {
  const original=baseSpec.ramp_curve_m;
  if(!Array.isArray(original)||original.length<3)return {candidates:[],reason:'No usable base curve.'};
  let join=0;
  while(join+1<original.length&&Math.abs(original[join+1].y-original[0].y)<1e-9&&original[join+1].x>original[join].x)join++;
  if(join<2||join===original.length-1)return {candidates:[],reason:'This bounded family requires a forward flat approach before the existing high ramp; current base geometry is preserved rather than silently replaced.'};
  const start=original[0],end=original[join],span=end.x-start.x,tail=original.slice(join+1),available=baseSpec.car_mass_kg*g+baseSpec.downforce_capability_n;
  const energyHeight=baseSpec.entry_speed_ms**2/(2*g),candidates=[],seen=new Set();
  const bottomR=Math.ceil((baseSpec.car_mass_kg*baseSpec.entry_speed_ms**2/available)*1.10*10)/10;
  const topR=Math.ceil((baseSpec.car_mass_kg*Math.max(0,baseSpec.entry_speed_ms**2-2*g*bottomR)/available)*1.04*10)/10;
  function add(points,parameters) {
    if(points.length>1000||points.some((p,i)=>i&&p.x===points[i-1].x&&p.y===points[i-1].y))return;
    const required=requiredForce(points,baseSpec);if(required>available)return;
    const deck=roadClearance(points,wall);if(!deck.clear)return;
    const key=JSON.stringify(points);if(seen.has(key))return;seen.add(key);
    candidates.push({problemSpec:{...copy(baseSpec),ramp_curve_m:points},parameters,screenRequiredForceN:required,roadClearance:deck,cost:parameters.heightM});
  }
  // Peak center is wall-relative. x=-18/-15/-12 therefore changes geometry.
  const centers=[...new Set([-3,-2,-1.5,-1,0,1,1.5,2,3].map(d=>clamp(wall.x+d,start.x+3,end.x-3)))];
  for(const height of [.25,.5,.75,1,1.5,2,3,4].map(d=>wall.height-start.y+d)) {
    if(height<=0||height>=energyHeight)continue;
    for(const center of centers) {
      const points=[],steps=Math.ceil(span/.12);
      for(let i=0;i<=steps;i++) {
        const x=start.x+span*i/steps,t=x<=center?(x-start.x)/(center-start.x):(end.x-x)/(end.x-center);
        points.push({x,y:start.y+height*smooth(clamp(t,0,1))});
      }
      points[0]=copy(start);points[points.length-1]=copy(end);
      add(points.concat(copy(tail)),{family:'quintic-bump',heightM:height,peakXM:center});
    }
  }
  // Shift crest geometry with wall position using unequal top-arc radii.
  // All arc/line joins remain tangent-continuous; the original tail is untouched.
  const shift=clamp((wall.x-(start.x+end.x)/2)*.25,-1.2,1.2);
  const leftTopR=topR+Math.max(shift,0),rightTopR=topR+Math.max(-shift,0);
  const plateau=span-2*bottomR-leftTopR-rightTopR;
  const minimumHeight=bottomR+Math.max(leftTopR,rightTopR);
  if(plateau>=0) {
    const initialHeight=Math.max(minimumHeight,wall.height-start.y+.3);
    const heights=[...new Set([minimumHeight,...Array.from({length:40},(_,i)=>initialHeight+i*.4)])].filter(h=>h<energyHeight-.1);
    for(const height of heights) {
      const points=[copy(start)];
      const line=(dx,dy)=>{if(Math.hypot(dx,dy)<1e-9)return;const p=points.at(-1),n=Math.ceil(Math.hypot(dx,dy)/.12);for(let i=1;i<=n;i++)points.push({x:p.x+dx*i/n,y:p.y+dy*i/n});};
      const arc=(a,b,r)=>{const p=points.at(-1),sign=b>a?1:-1,n=Math.ceil(Math.abs(b-a)*r/.12);for(let i=1;i<=n;i++){const t=a+(b-a)*i/n;points.push({x:p.x+r/sign*(Math.sin(t)-Math.sin(a)),y:p.y-r/sign*(Math.cos(t)-Math.cos(a))});}};
      arc(0,Math.PI/2,bottomR);line(0,height-bottomR-leftTopR);arc(Math.PI/2,0,leftTopR);line(plateau,0);
      arc(0,-Math.PI/2,rightTopR);line(0,-(height-bottomR-rightTopR));arc(-Math.PI/2,0,bottomR);
      points[points.length-1]=copy(end);
      add(points.concat(copy(tail)),{family:'rounded-arch',heightM:height,bottomRadiusM:bottomR,leftTopRadiusM:leftTopR,rightTopRadiusM:rightTopR,plateauM:plateau,wallXM:wall.x});
    }
  }
  candidates.sort((a,b)=>a.cost-b.cost);
  return {candidates:candidates.slice(0,127),reason:null,search:{currentBasePointCount:original.length,approachEndIndex:join,preservedTailPoints:tail.length,originalStart:copy(start),originalJoin:copy(end),availableForceN:available,energyHeightM:energyHeight,maxCandidates:127,onlyCurveChanges:true,limitations:'Two bounded approach deformation families, not a globally optimal or universally feasible shape search.'}};
}

export function generateWallCandidates(baseSpec, wall) {
  const primary=generateApproachCandidates(baseSpec,wall);
  if(primary.candidates.length||!primary.search)return primary;

  // A wall near the fixed join can intersect the road at y=0 for every
  // approach-only candidate. Try a bounded horizontal translation of the tall
  // bend, regenerating only the flat approach and preserving its start. The
  // bend's relative geometry and all physical parameters remain unchanged.
  const original=baseSpec.ramp_curve_m,join=primary.search.approachEndIndex;
  const start=original[0],span=original[join].x-start.x,candidates=[];
  const joinShiftsM=[2,4,6,8,10,12];
  for(const joinShiftXM of joinShiftsM) {
    const translated=copy(baseSpec);
    translated.ramp_curve_m=original.map((point,i)=>({
      x:i<=join?start.x+(point.x-start.x)*(span+joinShiftXM)/span:point.x+joinShiftXM,
      y:point.y,
    }));
    const extension=generateApproachCandidates(translated,wall);
    for(const candidate of extension.candidates)candidates.push({
      ...candidate,
      parameters:{...candidate.parameters,family:`translated-${candidate.parameters.family}`,joinShiftXM,translatedTailPoints:original.length-join-1},
    });
  }
  candidates.sort((a,b)=>a.cost-b.cost||a.parameters.joinShiftXM-b.parameters.joinShiftXM);
  return {
    candidates:candidates.slice(0,127),reason:null,
    search:{...primary.search,joinShiftsM,translatedTailShapePreserved:true,
      limitations:'Bounded approach deformation with a horizontal bend-translation fallback, not a globally optimal or universally feasible shape search.'},
  };
}

// Interface requested by server/obstacle-api.mjs. Score only ranks this bounded
// candidate family. Actual solver + assessWall must decide whether it is usable.
export function makeCandidates(spec, wall) {
  return generateWallCandidates(spec,wall).candidates.map(candidate=>({
    problemSpec:candidate.problemSpec,
    adjustment:{liftM:candidate.parameters.heightM,kind:candidate.parameters.family,...candidate.parameters,roadClearance:candidate.roadClearance},
    score:candidate.cost,
  }));
}

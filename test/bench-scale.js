const focus=require('../out/focus'), classify=require('../out/classify'), sc=require('../out/scopecolor'), fs=require('fs');
const base=fs.readFileSync(__dirname+'/../samples/sample.go','utf8');
const baseTokens=require('./fixtures/sample.go.tokens.json');
function scaled(mult){
  let text=base, tokens=baseTokens.slice();
  const unit=base.length;
  for(let k=1;k<mult;k++){ tokens=tokens.concat(baseTokens.map(t=>({...t,offset:t.offset+unit*k}))); text+=base; }
  return {text,tokens};
}
const MODE=process.argv[2]||'indexed';
for(const mult of [1,5,10,25]){
  const {text,tokens}=scaled(mult);
  const allBlocks=focus.scanBraceBlocks(text);
  const fnRanges=[]; let i=-1; while((i=text.indexOf('func ',i+1))!==-1){const o=text.indexOf('{',i);const b=allBlocks.find(bl=>bl.openOffset===o);if(b)fnRanges.push({start:i,end:b.closeOffset+1});}
  const scopeFn=fnRanges.reduce((a,b)=>(b.end-b.start)>(a.end-a.start)?b:a);
  const sb=allBlocks.filter(x=>x.openOffset>=scopeFn.start&&x.closeOffset<scopeFn.end);
  const N=mult>10?10:40;
  const s=process.hrtime.bigint();
  for(let r=0;r<N;r++){
    const idx = MODE==='indexed' ? classify.buildFileIndex(text,tokens,fnRanges) : undefined;
    const per=sb.map(bl=>{
      const L=focus.lexRegionFor(text,bl), D=focus.declRegionFor(text,bl);
      const S=allBlocks.filter(x=>x.openOffset>bl.openOffset&&x.closeOffset<bl.closeOffset).map(x=>focus.lexRegionFor(text,x));
      const c=classify.classifyFromSemantic(text,L,classify.enclosingFnOf(fnRanges,bl.openOffset),fnRanges,tokens,1,focus.focusKeyOf(bl),classify.outermostFnOf(fnRanges,bl.openOffset),D,S,idx);
      return {focusKey:c.focusKey,byName:c.byName};
    });
    sc.colorScope(per,5);
  }
  const e=process.hrtime.bigint();
  console.log(`x${String(mult).padEnd(3)} ${String(text.length).padStart(7)} chars, ${String(allBlocks.length).padStart(4)} blocks, scope=${String(sb.length).padStart(2)} → ${(Number(e-s)/1e6/N).toFixed(2)} ms`);
}

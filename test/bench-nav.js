// Real-world path: index cached per doc version, user navigates between blocks.
const focus=require('../out/focus'), classify=require('../out/classify'), sc=require('../out/scopecolor'), fs=require('fs');
const base=fs.readFileSync(__dirname+'/../samples/sample.go','utf8');
const baseTokens=require('./fixtures/sample.go.tokens.json');
let text=base, tokens=baseTokens.slice();
for(let k=1;k<25;k++){ tokens=tokens.concat(baseTokens.map(t=>({...t,offset:t.offset+base.length*k}))); text+=base; }
const allBlocks=focus.scanBraceBlocks(text);
const fnRanges=[]; let i=-1; while((i=text.indexOf('func ',i+1))!==-1){const o=text.indexOf('{',i);const b=allBlocks.find(bl=>bl.openOffset===o);if(b)fnRanges.push({start:i,end:b.closeOffset+1});}
const scopeFn=fnRanges.reduce((a,b)=>(b.end-b.start)>(a.end-a.start)?b:a);
const sb=allBlocks.filter(x=>x.openOffset>=scopeFn.start&&x.closeOffset<scopeFn.end);

// cached once per version (what bundleFor does)
const idxStart=process.hrtime.bigint();
const idx=classify.buildFileIndex(text,tokens,fnRanges);
console.log('buildFileIndex (once per version):', (Number(process.hrtime.bigint()-idxStart)/1e6).toFixed(2)+' ms');

const N=200, s=process.hrtime.bigint();
for(let r=0;r<N;r++){
  const per=sb.map(bl=>{
    const L=focus.lexRegionFor(text,bl), D=focus.declRegionFor(text,bl);
    const S=allBlocks.filter(x=>x.openOffset>bl.openOffset&&x.closeOffset<bl.closeOffset).map(x=>focus.lexRegionFor(text,x));
    const c=classify.classifyFromSemantic(text,L,classify.enclosingFnOf(fnRanges,bl.openOffset),fnRanges,tokens,1,focus.focusKeyOf(bl),classify.outermostFnOf(fnRanges,bl.openOffset),D,S,idx);
    return {focusKey:c.focusKey,byName:c.byName};
  });
  sc.colorScope(per,5);
}
console.log('scope classify+colour (cached index):', (Number(process.hrtime.bigint()-s)/1e6/N).toFixed(2)+' ms  ← per focus change on a 100KB file');
console.log('file:', text.length,'chars,',allBlocks.length,'blocks, scope',sb.length,'blocks');

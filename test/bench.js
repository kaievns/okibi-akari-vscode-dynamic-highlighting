const focus=require('../out/focus'), classify=require('../out/classify'), sc=require('../out/scopecolor'), fs=require('fs');
const text=fs.readFileSync(__dirname+'/../samples/sample.go','utf8');
const tokens=require('./fixtures/sample.go.tokens.json');
const N=200;
const t=(label,fn)=>{const s=process.hrtime.bigint(); for(let i=0;i<N;i++) fn(); const e=process.hrtime.bigint(); console.log(label.padEnd(38), (Number(e-s)/1e6/N).toFixed(3)+' ms/op');};

t('scanBraceBlocks (whole file)', ()=>focus.scanBraceBlocks(text));
const allBlocks=focus.scanBraceBlocks(text);
t('lexIdentifiers (whole file)', ()=>focus.lexIdentifiers(text));
const fnRanges=[]; let i=-1; while((i=text.indexOf('func ',i+1))!==-1){const o=text.indexOf('{',i);const b=allBlocks.find(bl=>bl.openOffset===o);if(b)fnRanges.push({start:i,end:b.closeOffset+1});}
const b=allBlocks.find(x=>x.openOffset===text.indexOf('{',text.indexOf('func summarize')));
const lexR=focus.lexRegionFor(text,b), declR=focus.declRegionFor(text,b);
const subs=allBlocks.filter(x=>x.openOffset>b.openOffset&&x.closeOffset<b.closeOffset).map(x=>focus.lexRegionFor(text,x));
t('classifyFromSemantic (1 block)', ()=>classify.classifyFromSemantic(text,lexR,classify.enclosingFnOf(fnRanges,b.openOffset),fnRanges,tokens,1,'k',classify.outermostFnOf(fnRanges,b.openOffset),declR,subs));

// full scope pass (what classifyScope does): classify every block in a scope
const scopeFn=fnRanges.find(r=>text.slice(r.start,r.start+26).includes('summarize'));
const sb=allBlocks.filter(x=>x.openOffset>=scopeFn.start&&x.closeOffset<scopeFn.end);
t(`classify SCOPE (${sb.length} blocks)`, ()=>{
  const per=sb.map(bl=>{
    const L=focus.lexRegionFor(text,bl), D=focus.declRegionFor(text,bl);
    const S=allBlocks.filter(x=>x.openOffset>bl.openOffset&&x.closeOffset<bl.closeOffset).map(x=>focus.lexRegionFor(text,x));
    const c=classify.classifyFromSemantic(text,L,classify.enclosingFnOf(fnRanges,bl.openOffset),fnRanges,tokens,1,focus.focusKeyOf(bl),classify.outermostFnOf(fnRanges,bl.openOffset),D,S);
    return {focusKey:c.focusKey,byName:c.byName};
  });
  sc.colorScope(per,5);
});
// worst case: whole-file scope (every block)
t(`classify ALL blocks (${allBlocks.length})`, ()=>{
  const per=allBlocks.map(bl=>{
    const L=focus.lexRegionFor(text,bl), D=focus.declRegionFor(text,bl);
    const S=allBlocks.filter(x=>x.openOffset>bl.openOffset&&x.closeOffset<bl.closeOffset).map(x=>focus.lexRegionFor(text,x));
    const c=classify.classifyFromSemantic(text,L,classify.enclosingFnOf(fnRanges,bl.openOffset),fnRanges,tokens,1,focus.focusKeyOf(bl),classify.outermostFnOf(fnRanges,bl.openOffset),D,S);
    return {focusKey:c.focusKey,byName:c.byName};
  });
  sc.colorScope(per,5);
});
console.log('\nfile:', text.length, 'chars |', allBlocks.length, 'blocks |', tokens.length, 'tokens');

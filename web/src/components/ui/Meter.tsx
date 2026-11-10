/** Labeled level rail adapted from BoardUI Meter's value/range anatomy. */
export function Meter({value,label,description}:{value:number,label:string,description?:string}){
  const clamped=Math.max(0,Math.min(100,value))
  return <div className="meter"><div className="meter-heading"><span>{label}</span><strong>{Math.round(clamped)}%</strong></div><div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}><div className="meter-fill" style={{transform:`scaleX(${clamped / 100})`}}/></div>{description&&<small>{description}</small>}</div>
}

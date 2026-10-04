import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { localDay,addDays,summarize } from '../shared/health-analytics'
import type { HealthRecords,HealthSession } from '../shared/types'
export function useHealthToday() {
  const now=ref(new Date()),records=ref<HealthRecords>({segments:[],events:[]}),session=ref<HealthSession>({active:false,startedAt:null}),error=ref('')
  let off:(()=>void)|undefined,timer:ReturnType<typeof setInterval>
  async function refresh(){try{const start=localDay(new Date());const [r,s]=await Promise.all([window.todoPet.health.records(start.toISOString(),addDays(start,1).toISOString()),window.todoPet.health.session()]);records.value=r;session.value=s;now.value=new Date()}catch(e){error.value=String(e)}}
  onMounted(()=>{void refresh();off=window.todoPet.events.onHealthSession(()=>void refresh());timer=setInterval(()=>{const old=now.value;now.value=new Date();if(localDay(old).getTime()!==localDay(now.value).getTime())void refresh()},1000)})
  onBeforeUnmount(()=>{off?.();clearInterval(timer)})
  const today=computed(()=>summarize(records.value,localDay(now.value),addDays(localDay(now.value),1),now.value))
  return {now,records,session,today,error,refresh}
}

/**
 * Plain sentences for action results. `useGrid` words a result like "stop coordinator1 completed."; the board says what happened to what.
 * Anything it does not recognise is only capitalised, never reworded.
 */
const service = (id: string): string => {
  const coordinator = /^coordinator(\d+)$/.exec(id)
  if (coordinator) return `coordinator ${coordinator[1]}`
  if (id === 'postgres') return 'the database'
  if (id === 'mosquitto') return 'the MQTT broker'
  const gateway = /^gateway[ -](.+)$/.exec(id)
  if (gateway) return `the ${gateway[1].split(/[ -]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} gateway`
  return id
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function describeNotice(text: string): string {
  const done = /^(start|stop) (.+) completed\.$/.exec(text)
  if (done) return capital(`${done[1] === 'start' ? 'started' : 'stopped'} ${service(done[2])}.`)
  return capital(text)
}

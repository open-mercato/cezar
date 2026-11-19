import { mascotAsset } from './src/routes/manager/mascot-assets'
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ManagerMascot } from './src/routes/manager/manager-mascot'
import { MASCOT_ACTIVITIES, type MascotActivity } from './src/routes/manager/mascot-motion'
import type { ManagerMascot as Character } from '@open-mercato/cezar-api-client'
import './src/styles/index.css'
import './mascots.css'
const characters: Character[] = ['base','builder','analyst','guardian','dispatcher','reviewer','automator','planner','scout']
const names = ['Cezar','Builder','Analyst','Guardian','Dispatcher','Reviewer','Automator','Planner','Scout']
function Studio() {
 const [selected,setSelected] = useState<Character>('base')
 const [activity,setActivity] = useState<MascotActivity>('idle')
 const [dark,setDark] = useState(false)
 const [animated,setAnimated] = useState(true)
 const [take,setTake] = useState(0)
 return <main className={dark?'studio night':'studio'}>
 <header><a href="#" className="brand">C<span>CEZAR<br/><small>CHARACTER STUDIO</small></span></a><button onClick={()=>setDark(!dark)}>{dark?'Light canvas':'Dark canvas'}</button></header>
 <section className="intro"><p className="eyebrow">A LITTLE CHARACTER. A LOT OF CAPABILITY.</p><h1>Meet your managers.</h1><p>Nine personalities. One team. A familiar face for every kind of work.</p></section>
 <section className="stage"><div className="hero-art"><div className="halo"/><ManagerMascot key={selected+take} mascot={selected} activity={activity} animated={animated} className="hero-mascot"/></div><div className="direction"><p className="eyebrow">{String(characters.indexOf(selected)+1).padStart(2,'0')} / THE CEZAR COLLECTION</p><h2>{names[characters.indexOf(selected)]}</h2><p>Golden laurels, a helping hand, and a little personality. Choose an activity to see the character come to life.</p><div className="activities">{MASCOT_ACTIVITIES.map(state=><button key={state} aria-pressed={activity===state} onClick={()=>{setActivity(state);setTake(t=>t+1)}}>{state}</button>)}</div><button className="pause" onClick={()=>setAnimated(!animated)}>{animated?'Pause motion':'Resume motion'}</button><div className="sizes">{[32,48,64].map(size=><div key={size}><img src={mascotAsset(selected,'portrait')} width={size} height={size}/><small>{size}px</small></div>)}<span>Designed for the sidebar.<br/>Alive in the conversation.</span></div></div></section>
 <section className="lineup" aria-label="Characters">{characters.map((id,i)=><button key={id} aria-label={names[i]} aria-pressed={selected===id} onClick={()=>setSelected(id)}><img src={mascotAsset(id,'standing')} alt=""/><span>{names[i]}</span><small>{String(i+1).padStart(2,'0')}</small></button>)}</section>
 <footer><span>CEZAR MANAGER · MOTION STUDY</span><span>Original raster artwork · Layered animation · Reduced motion supported</span></footer>
 </main>
}
createRoot(document.getElementById('root')!).render(<Studio/>);

import {aiConfig} from './ai-config.js';
import {applyCommentary} from './commentary.js?v=match-commentary-20261026-1';
import {localAppCheckDebugToken} from './ai-local-config.js';
import {createMultiplayerUI} from './multiplayer.js';
import {connectCloud,cloudEnabled} from './cloud.js?v=match-commentary-20261026-1';
import {firebaseConfig} from './firebase-config.js';
import {catalogue,colours,commanders,armyValue,findCountry,initials,populationReference,savedCountryPopulation} from './data.js';
import {createPopulationStore,populationFetcher,localPopulationFetcher,refreshSetupPopulation} from './populations.js';
import {GameEngine,LocalGameRepository,reportText} from './engine.js';
import {difficultyFor,difficultyOptions} from './difficulty.js';
import {worldPaths} from './assets/world-paths.js?v=map-seam-20261026-1';
import {MotionDirector,countryPoint,connectionPath,countryMotion,diceMotion,mapEffects,mapOverlay,turnMotion,victoryMotion,casualtyMarkers,resolveReducedMotion,presentationGame,rollPending} from './motion.js?v=battle-reveal-20261026-1';
import {SoundDirector} from './audio.js?v=quick-audio-20261024-1';
import {normalizeNickname,playerNickname} from './profile.js';

const app=document.getElementById('app');
let repository=new LocalGameRepository(),cloud=null,cloudReady=!cloudEnabled;
let campaignLoadState=cloudEnabled?'loading':'ready',campaignLoadError='';
const audioDirector=new SoundDirector({onChange:syncAudioControls});
const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
let motionChoice='auto';
try{motionChoice=localStorage.getItem('meridian-motion-preference')||'auto';}catch{}
const motionDirector=new MotionDirector({reducedMotion:resolveReducedMotion(motionChoice,motionPreference.matches)});
document.documentElement.dataset.motion=motionDirector.reducedMotion?'reduced':'full';
let motionFrame=null;
let games=cloudEnabled?[]:repository.load();
if(!Array.isArray(games))games=[];
let profile;try{profile=JSON.parse(localStorage.getItem('meridian-ui-profile'))||null;}catch{profile=null;}
if(cloudEnabled)profile=null;
const state={view:'welcome',gameId:null,action:'planning',origin:null,target:null,selected:null,allocations:{},filter:'all',search:'',setupStart:'ZA',setupDifficulty:'medium',setupName:'Southern Meridian',setupSearch:'',setupGame:null,replay:0,fast:false,npcNote:'',watch:null,watchNPC:false};
let populationStorage;try{populationStorage=localStorage;}catch{}
const populations=createPopulationStore({catalogue,reference:populationReference,storage:populationStorage,fetchSnapshot:localAppCheckDebugToken?localPopulationFetcher():populationFetcher(firebaseConfig),onChange({changed}){
  if(changed)refreshSetupPopulation(state.setupGame,catalogue,populationReference,armyValue);
  if(changed&&state.view==='setup'){
    const focused=document.activeElement,id=focused?.id,start=focused?.selectionStart,end=focused?.selectionEnd;
    render();const input=id&&document.getElementById(id);if(input){input.focus();if(typeof start==='number')input.setSelectionRange(start,end);}
  }
  for(const node of document.querySelectorAll('[data-population-status]'))node.textContent=populationStatus();
}});
function populationStatus(){return `Worldometers · ${populationReference.year} estimates · ${populations.status==='unavailable'?'Using saved data · ':''}Snapshot checked ${new Date(populationReference.fetchedAt).toLocaleDateString()}`;}
function campaignPopulationLabel(game){return Number.isInteger(game.populationSource?.year)?`Worldometers · ${game.populationSource.year} population snapshot`:'Original campaign population snapshot';}
let npcBusy=false,replayTimer=null,toastTimer=null;
let nicknameSaving=false,nicknameError='';
const multiplayer=createMultiplayerUI({getCloud:()=>cloud,notify:message=>notify(message),changed:()=>render(),mapView:(countries,options)=>theatre(countries,{...options,motion:motionFrame}),diceView:pairs=>dicePairs(pairs),presentGame:g=>presentationGame(g,motionFrame),isRolling:()=>rollPending(motionFrame)});
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconPaths={settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',audio:'M11 4 6 8H2v8h4l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',arrow:'M5 12h14m-5-5 5 5-5 5',chevron:'m9 5 7 7-7 7',back:'m14 5-7 7 7 7',plus:'M12 5v14M5 12h14',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z',lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',copy:'M8 8h12v13H8zM4 16H3V3h12v2',check:'m5 12 4 4 10-10',swords:'m4 3 17 17M3 4l4-1-1 4M20 3 3 20m18-16-4-1 1 4M2 16l6 6m8-20 6 6',transfer:'M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4',skip:'m5 5 10 7-10 7zM19 5v14',fast:'m2 5 9 7-9 7zm10 0 9 7-9 7z',pause:'M8 5v14M16 5v14',play:'m7 4 13 8-13 8z',history:'M3 4v6h6M4 9a9 9 0 1 1 0 7m8-10v6l4 2',users:'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3m13-16a4 4 0 0 1 0 8m6 8v-3a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',info:'M12 11v6M12 7v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',close:'m6 6 12 12M6 18 18 6',refresh:'M20 4v6h-6M4 20v-6h6M4 9a8 8 0 0 1 13-5m3 11a8 8 0 0 1-13 5',eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12m13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',trophy:'M8 3h8v8a4 4 0 0 1-8 0zM8 5H3v3a5 5 0 0 0 5 5m8-8h5v3a5 5 0 0 1-5 5M12 15v6m-5 0h10',save:'M5 3h12l4 4v14H3V3zm3 0v7h8V3M7 21v-7h10v7',logout:'M10 3H4v18h6m4-5 5-4-5-4m-5 4h10',mail:'M3 5h18v14H3zm0 1 9 7 9-7'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name]||iconPaths.globe}"/></svg>`;
const btn=(text,action,variant='',extra='')=>`<button type="button" class="btn ${variant}" data-action="${action}" ${extra}>${text}</button>`;
const difficultyBadge=id=>{const level=difficultyFor(id);return `<span class="badge difficulty-badge" style="--difficulty-colour:${level.colour}">${level.label}</span>`;};
const settingsControl=()=>btn(icon('settings'),'settings','btn-sm settings-trigger', 'aria-haspopup="dialog" aria-controls="settings-dialog" aria-label="Settings" title="Animation and sound settings"');
const motionControl=()=>btn(`${icon(motionDirector.reducedMotion?'play':'pause')} Animations: ${motionDirector.reducedMotion?'Reduced':'On'}`,'motion','btn-sm',`aria-pressed="${!motionDirector.reducedMotion}" aria-label="${motionDirector.reducedMotion?'Enable full animations':'Reduce animations'}" title="${motionDirector.reducedMotion?'Enable troop movements, missiles and casualty effects':'Use reduced motion'}"`);
const brand=()=>`<a href="#welcome" class="brand" aria-label="Meridian Conquest home"><img src="./assets/compass.svg" alt=""><span class="brand-title">MERIDIAN<span>CONQUEST</span></span></a>`;
const currentGame=()=>state.view==='multiplayer'?multiplayer.game:state.watch||games.find(g=>g.id===state.gameId);
const engine=()=>new GameEngine(currentGame());
const owned=(g,player=0)=>g.countries.filter(c=>c.owner===player);
const nameOf=p=>escape((currentGame()?.playerNames||(state.view==='setup'?state.setupGame?.playerNames:null))?.[p]||commanders[p]);
function refreshSetupNickname(){
  const game=state.setupGame,name=profile?.name?playerNickname(profile.name):'You';
  if(!game||game.playerNames?.[0]===name)return;
  game.playerNames=[name,...commanders.slice(1)];
  // This is the unsaved preview: regenerate only its initial turn report.
  game.events=[];game.turnStarted=false;new GameEngine(game).beginTurn();
}
const notify=message=>{const node=document.getElementById('toast');node.textContent=message;node.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('visible'),3500);};
function save(){
  if(state.watch)return;
  if(!repository.save(games))notify('Browser storage is unavailable. Keep this tab open to retain your progress.');
  if(cloud?.user&&cloudReady)cloud.save(games).catch(()=>notify('Cloud save failed. Progress is kept on this device; reconnect and try again.'));
}
function nav(active='',compact=false){return `<header class="navbar ${compact?'game-nav':''}">${brand()}<nav class="nav-links" aria-label="Main navigation"><a href="#campaigns" class="${active==='campaigns'?'active':''}">My campaigns</a><a href="#setup" class="${active==='setup'?'active':''}">New campaign</a><a href="#multiplayer" class="${active==='multiplayer'?'active':''}">Multiplayer</a><a href="#how-to-play">How to play</a></nav><div class="nav-account">${settingsControl()}${cloud?.user?btn('Sign out','sign-out','btn-sm'):''}${compact?`<a href="#campaigns" class="btn btn-ghost btn-sm">${icon('back')} My games</a>`:''}${profile?`<button class="account-link btn-ghost" data-action="account" title="Edit player nickname" aria-label="Edit player nickname"><span class="avatar">${escape(initials(profile.name))}</span><span class="account-name">${escape(profile.name)}</span></button>`:`${!compact?'<span class="nav-demo">SINGLE-PLAYER STRATEGY</span>':''}<a href="#signin" class="link-button">Sign in</a>${!compact?'<a href="#signup" class="btn btn-sm">Create account</a>':''}`}</div></header>`;}
function footer(){return `<footer class="footer"><span class="footer-name">MERIDIAN CONQUEST <span class="gold">/</span> A WORLD OF POSSIBILITY.</span><span>Interactive demo · Progress saved on this device</span><a href="#how-to-play">Rules of engagement ↗</a></footer>`;}
function map(countries=catalogue.slice(0,10).map((c,i)=>({...c,owner:i,army:armyValue(c.population)})),{interactive=false,mini=false,selected=null,origin=null,target=null,motion=null,playerNames=null}={}){
  const set=new Map(countries.map(c=>[c.id,c]));
  const markers=countries.map((c,i)=>{
    const [x,y]=countryPoint(c);
    const dx=c.code==='GB'?-29:c.code==='NO'?16:c.code==='JP'?12:0,dy=c.code==='CA'?-11:c.code==='GB'?15:c.code==='NO'?-14:c.code==='EG'?-12:17;
    const colour=colours[c.owner??i];
    return `<g class="map-marker ${interactive?'interactive':''} ${selected===c.code?'selected':''}" style="--marker:${colour}" ${interactive?`data-map-country="${c.code}" data-action="select-country" data-code="${c.code}" role="button" tabindex="0" aria-label="${escape(c.name)}, ${c.army} soldiers, ${nameOf(c.owner)}"`:''}>${selected===c.code&&!mini?`<circle class="selection-ring" cx="${x}" cy="${y}" r="11"/>`:''}<circle cx="${x}" cy="${y}" r="${mini?3:5}"/>${!mini?`<text x="${x+dx}" y="${y+dy}" text-anchor="middle">${c.code} · ${c.army}</text>`:''}</g>`;
  }).join('');
  const a=countries.find(c=>c.code===(motion?.route?.from||origin||selected)),b=countries.find(c=>c.code===(motion?.route?.to||target));
  const suffix=mini?'mini':interactive?'game':'hero',arrowId=`attack-arrow-${suffix}`,routeType=motion?.route?.kind==='transfer'?'transfer':'',routeColour=routeType?'#2DD4BF':'#E9CD76';
  let connection='';
  if(a&&b&&a!==b){const path=connectionPath(a,b);connection=motion?.route?.active?`<path class="map-attack-glow ${routeType}" d="${path}"/><path class="map-attack-route ${routeType}" marker-end="url(#${arrowId})" d="${path}"/>`:`<path class="map-line" d="${path}"/>`;}
  const zoom=victoryMotion(motion);
  const land=worldPaths.map(p=>{
    const c=set.get(p.id),effect=c?countryMotion(motion,c):null;
    return `<path d="${p.d}" class="land ${c?'active':''} ${c&&interactive?'interactive':''} ${selected===c?.code?'selected':''} ${effect?.className||''}" ${c?`style="${effect.style}"`:''} ${c&&interactive?`data-map-country="${c.code}" data-action="select-country" data-code="${c.code}"`:''}/>`;
  }).join('');
  return `<div class="map-viewport"><svg class="world-map ${zoom.className}" style="${zoom.style}" viewBox="0 0 960 480" role="img" aria-label="World map showing the ten participating countries and their soldier counts"><defs><pattern id="grid-${suffix}" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" class="map-grid" fill="none"/></pattern><marker id="${arrowId}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8L2 4Z" fill="${routeColour}"/></marker></defs><rect width="960" height="480" fill="url(#grid-${suffix})"/>${land}${connection}${markers}${mapEffects(motion,countries)}</svg>${mapOverlay(motion)}${!mini?`<span class="map-coordinate">WORLD THEATRE / ${interactive?'LIVE BOARD':'GLOBAL VIEW'}</span><span class="map-compass">N<svg viewBox="0 0 30 30"><path d="M15 2v26M2 15h26m-13-9 3 9-3 9-3-9z"/></svg></span>`:''}</div>`;
}
function theatre(countries,options={}){return `<section class="theatre ${options.interactive?'game-theatre':''}"><div class="theatre-head"><span class="eyebrow">${options.interactive||options.live?'The world theatre':'Your next campaign'}</span><span class="badge live">${options.live?'Live match':options.interactive?'10 countries':'Awaiting command'}</span></div>${map(countries,options)}<div class="theatre-footer"><span class="caption">Global range · Every enemy is within reach</span><span class="badge">${icon('globe')} No borders</span></div></section>`;}
function welcome(){return `<div class="shell">${nav()}<main><section class="hero"><div class="hero-copy"><div class="eyebrow">A world of strategy. One commander.</div><h1>Choose your nation.<br>Build your army.<br><span class="outline-word">Conquer the world.</span></h1><p>Ten real countries. Nine strategic opponents. A single objective: bring the entire board under your command.</p><div class="hero-actions"><a href="#campaigns" class="btn btn-primary">Enter the war room ${icon('arrow')}</a><a href="#multiplayer" class="btn">${icon('users')} Play with friends</a>${btn(`${icon('play')} How to play`,'help')}</div><div class="hero-footnotes"><span>${icon('users')} Single player</span><span>${icon('save')} Persistent sessions</span><span>${icon('eye')} Watch the action</span></div></div><div>${theatre()}<div class="map-callout">${icon('globe')}<div>Every country is within reach.<br><span class="caption">Your strategy sets the boundaries.</span></div></div></div></section><section class="principles"><article class="principle"><div class="eyebrow">01 / The foothold</div><h3>Choose your beginning.</h3><p>Pick your nation. Its population sets the strength of your first army.</p></article><article class="principle"><div class="eyebrow">02 / The strategy</div><h3>Outthink nine rivals.</h3><p>Reinforce, reposition, and choose the right moment to strike.</p></article><article class="principle"><div class="eyebrow">03 / The objective</div><h3>Make the world yours.</h3><p>Control all ten countries. Relive every turning point in battle replay.</p></article></section><section class="spectator-banner"><div><strong>Make your first move.</strong><p>Choose a country and difficulty, then begin your campaign.</p></div><a href="#setup" class="btn btn-sm">Start a campaign ${icon('arrow')}</a></section></main>${footer()}</div>`;}
function gameCard(g,index){const troops=owned(g).reduce((n,c)=>n+c.army,0),start=findCountry(g.start);return `<article class="campaign-card"><div class="campaign-art">${map(g.countries,{mini:true})}<span class="badge ${g.status==='won'?'gold':'live'}">${g.status==='won'?'World conquered':g.status==='lost'?'Viewing only':g.battle?'Battle in progress':g.order[g.position]===0?'Your move':'Opponent turn'}</span></div><div class="campaign-card-body"><div class="campaign-title-row"><div><h2>${escape(g.name)}</h2><div class="campaign-sub">${start.flag} Starting country: ${start.name} ${difficultyBadge(g.difficulty)}</div></div><span class="caption">0${index+1}</span></div><div class="campaign-stats"><div class="campaign-stat"><strong>${String(g.round).padStart(2,'0')}</strong>ROUND</div><div class="campaign-stat"><strong>${owned(g).length}<span class="muted small"> / 10</span></strong>COUNTRIES</div><div class="campaign-stat"><strong>${troops}</strong>SOLDIERS</div></div><div class="campaign-card-actions"><a href="#game/${g.id}" class="btn btn-primary">${g.winner!==null?'View results':'Resume campaign'} ${icon('arrow')}</a><a href="#history/${g.id}" class="btn" aria-label="Replay ${escape(g.name)}">${icon('history')}</a><button class="icon-button" data-action="share" data-id="${g.id}" aria-label="Copy viewing-only snapshot link">${icon('copy')}</button></div></div></article>`;}
function filteredGames(){return games.filter(g=>(state.filter==='all'||(state.filter==='active'?g.status==='active':g.status===state.filter))&&`${g.name} ${findCountry(g.start)?.name}`.toLowerCase().includes(state.search.toLowerCase()));}
function campaignLoadNotice(){
  if(!cloudEnabled)return '';
  if(campaignLoadState==='loading')return '<div class="notice" role="status">Loading your saved campaigns and history...</div>';
  if(campaignLoadState==='error')return `<div class="notice" role="alert"><span><strong>Your campaigns could not finish loading.</strong> ${escape(campaignLoadError)} Your saved data has been kept.</span>${btn('Retry loading','retry-campaigns','btn-sm')}</div>`;
  return '';
}
function campaignResults(){
  const list=filteredGames();
  if(list.length)return list.map(gameCard).join('');
  if(cloudEnabled&&campaignLoadState==='loading')return '<div class="empty-state" style="grid-column:1/-1" role="status"><h2>Loading your campaigns...</h2><p>Your saved campaigns will appear here.</p></div>';
  if(cloudEnabled&&campaignLoadState==='error')return '';
  if(cloudEnabled&&!cloud?.user)return '<div class="empty-state" style="grid-column:1/-1"><h2>Sign in to see your campaigns.</h2><p>Your saves are linked to the account you played with.</p><a href="#signin" class="btn btn-primary">Sign in</a></div>';
  if(games.length)return `<div class="empty-state" style="grid-column:1/-1"><h2>No campaigns match your filters.</h2><p>Show all campaigns to include completed games.</p>${btn('Show all campaigns','clear-campaign-filters','btn-primary')}</div>`;
  return `<div class="empty-state" style="grid-column:1/-1"><div class="empty-symbol">⌖</div><h2>No campaigns in sight.</h2><p>No campaigns are saved under this account. Sign in with the account you played with, or create a campaign.</p><a href="#setup" class="btn btn-primary">Create a campaign ${icon('plus')}</a></div>`;
}
function dashboard(){return `<div class="shell">${nav('campaigns')}<main><div class="page-heading"><div><div class="eyebrow">Your command centre</div><h1>Every campaign. Your next move.</h1><p>Pick up where you left off, or set your sights on a new world.</p></div><div class="campaign-heading-actions"><a href="#setup" class="btn btn-primary">${icon('plus')} New campaign</a><a href="#multiplayer" class="btn">${icon('users')} Play with friends</a></div></div><div class="toolbar"><div class="search-wrap">${icon('search')}<input type="search" class="field" id="campaign-search" placeholder="Search campaigns or starting countries" aria-label="Search campaigns" value="${escape(state.search)}"></div><div class="filters" aria-label="Campaign status">${[['all','All campaigns'],['active','Active'],['won','Won'],['lost','Lost']].map(([v,t])=>`<button class="filter ${state.filter===v?'active':''}" aria-pressed="${state.filter===v}" data-action="filter" data-filter="${v}">${t}</button>`).join('')}</div></div><div class="section-label"><span>Your campaigns</span><span id="campaign-result-count">${filteredGames().length} SESSIONS</span></div>${campaignLoadNotice()}<div class="campaign-grid" id="campaign-results">${campaignResults()}</div><div class="save-note">${icon('save')} ${cloud?.user?`Signed in as ${escape(cloud.user.email||profile?.name)}. Campaigns save to your account.`:"Each campaign saves independently on this device, including any in-progress battle."}</div><div class="notice">${icon('info')}<span>Choose your country and difficulty to start a campaign. <strong>Progress saves on this device.</strong></span></div></main>${footer()}</div>`;}
function setupOptions(){return catalogue.filter(c=>c.name.toLowerCase().includes(state.setupSearch.toLowerCase())).map(c=>`<button class="country-option ${state.setupStart===c.code?'selected':''}" data-action="setup-country" data-code="${c.code}"><span class="flag">${c.flag}</span><span class="country-option-name">${c.name}<span class="country-owner">${Math.round(c.population*1000000).toLocaleString()} people</span></span><span class="strength">${armyValue(c.population)} ${icon('users')}</span>${state.setupStart===c.code?icon('check'):''}</button>`).join('')||'<p class="muted small">No matching countries in the catalogue.</p>';}
function difficultyPicker(){
  return `<fieldset class="difficulty-picker"><legend class="field-label">Difficulty</legend><div class="difficulty-options">${difficultyOptions.map(level=>`<label class="difficulty-option ${state.setupDifficulty===level.id?'selected':''}"><input type="radio" name="difficulty" id="difficulty-${level.id}" value="${level.id}" ${state.setupDifficulty===level.id?'checked':''} aria-describedby="difficulty-description-${level.id}"><span><strong style="--difficulty-colour:${level.colour}">${level.label}</strong><small id="difficulty-description-${level.id}">${level.description}</small></span></label>`).join('')}</div><p class="field-help">Saved with this campaign. Dice and troop rules stay the same.</p></fieldset>`;
}
function setup(){if(!state.setupGame)state.setupGame=GameEngine.create(state.setupName,state.setupStart,false,state.setupDifficulty,profile?.name);const chosen=findCountry(state.setupStart),g=state.setupGame;return `<div class="shell">${nav('setup')}<main><div class="page-heading"><div><div class="eyebrow">New campaign / 01</div><h1>Choose your foothold.</h1><p>One nation to begin with. A world to make your own.</p></div><span class="step-indicator"><span class="current">01 SETUP</span> / <span>02 COMMAND</span></span></div><div class="setup-grid"><section class="panel"><div class="panel-title"><span>Campaign details</span>${icon('globe')}</div><div class="panel-body"><div class="field-group"><label class="field-label" for="session-name">Campaign name</label><input class="field" id="session-name" maxlength="50" value="${escape(state.setupName)}" placeholder="Name your campaign"></div>${difficultyPicker()}<label class="field-label" for="country-search">Starting country</label><div class="search-wrap">${icon('search')}<input class="field" id="country-search" type="search" placeholder="Search the country catalogue" value="${escape(state.setupSearch)}"></div><div class="field-help">${catalogue.length} countries and territories · <a href="https://www.worldometers.info/world-population/population-by-country/" target="_blank" rel="noopener">Worldometers</a> · <a href="./assets/COUNTRY_DATA_CREDITS.txt" target="_blank" rel="noopener">Country data credits</a><br><span data-population-status>${populationStatus()}</span></div><div class="country-options" id="country-options">${setupOptions()}</div><div class="notice teal-notice">${icon('shield')}<span><strong>${chosen.name} selected · ${armyValue(chosen.population)} starting soldiers</strong><br>Initial army strength is determined by the population band.</span></div><div class="section-label"><span>Population → initial soldiers</span></div><div class="population-bands">${['≤ 5m','≤ 10m','≤ 25m','≤ 50m','≤ 75m','≤ 100m','≤ 125m','≤ 150m','> 150m'].map((v,i)=>`<div class="population-band">${v} <b>${i+1}</b></div>`).join('')}</div></div></section><div><section class="panel"><div class="panel-title"><span>Your world is ready</span>${btn(icon('refresh'),'redraw-roster','btn-ghost btn-sm','aria-label="Redraw random opponents"')}</div><div class="panel-body"><div class="caption">10 distinct countries / 9 rivals drawn</div><div class="roster-list">${g.countries.map((c,i)=>`<div class="setup-roster-row"><span>${c.flag}</span><span>${c.name}</span><span class="who" style="color:${colours[i]}">P${i+1} ${escape(g.playerNames?.[i]||commanders[i])}</span><span class="troop-number">${c.army}</span></div>`).join('')}</div><div class="notice" style="margin-top:18px">${icon('info')}<span><strong>${nameOf(g.order[0])} will take the first turn.</strong><br>The first participant is chosen randomly.</span></div></div><div class="setup-launch"><span class="small muted">Your next move awaits.</span>${btn(`Start campaign ${icon('arrow')}`,'create-game','btn-primary')}</div></section><div class="notice setup-bottom">${icon('users')}<span><strong>Round 1 starts without reinforcements.</strong><br>From round 2, receive two soldiers per controlled country at the start of your turn.</span></div></div></div></main>${footer()}</div>`;}
function auth(kind){const signup=kind==='signup',reset=kind==='reset';return `<div class="shell">${nav()}<main class="auth-workspace"><div class="auth-copy"><div class="eyebrow">Strategy has a starting point</div><h1>Your world.<br><span class="gold">Your next move.</span></h1><p>Build a campaign worth returning to. Your countries, troops and unfinished battles, ready when you are.</p><div class="auth-map">${map(undefined,{mini:true})}</div><div class="caption">10 countries / 9 strategic rivals / 1 commander</div></div><section class="panel auth-box"><div class="eyebrow">${signup?'Your first campaign awaits':reset?'Recover your command':'Welcome back, commander'}</div><h2>${signup?'Create your account.':reset?'Reset your password.':'Take command again.'}</h2><p>${signup?'Choose a player nickname for campaigns and multiplayer.':reset?'Request a password reset email.':'Your campaigns are waiting for their next chapter.'}</p><form id="auth-form" data-kind="${kind}">${signup?'<div class="field-group"><label class="field-label" for="display-name">Player nickname</label><input class="field" id="display-name" name="name" autocomplete="nickname" required minlength="2" maxlength="32" placeholder="Your player nickname"></div>':''}<div class="field-group"><label class="field-label" for="email">Email address</label><input type="email" class="field" id="email" name="email" autocomplete="email" required placeholder="commander@example.com"></div>${!reset?`<div class="field-group"><label class="field-label" for="password">Password ${!signup?'<a href="#reset" class="gold">Forgot password?</a>':''}</label><input type="password" class="field" id="password" name="password" autocomplete="${signup?'new-password':'current-password'}" minlength="8" required placeholder="At least 8 characters"></div>${signup?'<div class="field-group"><label class="field-label" for="confirm-password">Confirm password</label><input type="password" class="field" id="confirm-password" name="confirm" autocomplete="new-password" minlength="8" required placeholder="Repeat your password"></div>':''}`:''}<div class="form-error" id="form-error" role="alert"></div><button class="btn btn-primary btn-full" type="submit" ${cloudEnabled&&(!cloud||!cloudReady)?'disabled':''}>${signup?'Create account':reset?'Send reset email':'Sign in'} ${icon('arrow')}</button></form><div class="auth-switch">${signup?'Already have an account? <a href="#signin">Sign in</a>':reset?'<a href="#signin">Return to sign in</a>':'New to Meridian? <a href="#signup">Create account</a>'}</div><div class="auth-note">${cloudEnabled?'Sign in securely with Firebase. Campaigns are saved to your account.':'Account preview: Firebase has not been connected yet. No credentials are sent.'}</div></section></main>${footer()}</div>`;}

function die(value,result=''){const points={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]}[value];return `<span class="die ${result}" data-die-final="${value}" data-display-face="${value}" role="img" aria-label="Die roll ${value}">${Array.from({length:9},(_,i)=>`<i aria-hidden="true" ${points.includes(i)?'style="opacity:1"':''}></i>`).join('')}</span>`;}
function dicePairs(pairs=[]){const motion=diceMotion(motionFrame,pairs);return `<div class="dice-header"><span>ATTACK</span><span></span><span>DEFEND</span></div><div class="dice-pairs ${motion.className}" data-rolling="${motion.className==='dice-rolling'}" style="${motion.style}">${motion.className?'<div class="dice-roll-status"><span class="dice-status-dot"></span><span class="dice-status-text">Rolling the dice…</span></div>':''}${pairs.map(p=>`<div class="dice-pair" aria-label="${rollPending(motionFrame)?`Pair ${p.index}: rolling dice`:`Pair ${p.index}: ${p.a} versus ${p.d}, ${p.a===p.d?'tie':p.a>p.d?'defender loses one':'attacker loses one'}`}">${die(p.a,p.a>p.d?'winner':p.a<p.d?'loser':'')}<span>${p.a===p.d?'=':'vs'}</span>${die(p.d,p.d>p.a?'winner':p.d<p.a?'loser':'')}</div>`).join('')}</div>`;}
function roster(g){
  return `<aside class="panel roster-panel"><div class="roster-head">World roster <span class="badge">10 countries</span></div><div class="country-roster">${g.countries.map(c=>{
    const effect=countryMotion(motionFrame,c);
    return `<button class="country-row ${state.selected===c.code?'selected':''} ${c.owner===0?'owned':''} ${effect.className}" style="${effect.style}" data-map-country="${c.code}" data-action="select-country" data-code="${c.code}" aria-label="${c.name}, ${c.army} soldiers, owned by ${nameOf(c.owner)}"><span class="flag">${c.flag}</span><span class="country-name">${c.name}<span class="country-owner" style="color:${colours[c.owner]}">P${c.owner+1} ${nameOf(c.owner)}</span></span><span class="army-count">${c.army}</span>${casualtyMarkers(motionFrame,c,{roster:true})}</button>`;
  }).join('')}</div>${selectedDetail(g)}<p class="roster-note">P# identifies the owner. Colours stay with each commander.</p></aside>`;
}
function selectedDetail(g){const c=g.countries.find(x=>x.code===state.selected)||g.countries[0];return `<div class="selected-country"><div class="caption">Selected country</div><h3>${c.flag} ${c.name}</h3><p>${c.owner===0?'Under your command':`Controlled by ${nameOf(c.owner)}`}<br>Original strength: ${c.value} · Current army: ${c.army}<br>${c.owner===0&&c.army>=2?'Can launch an attack on your turn.':c.owner===0?'Reinforce to launch an attack.':'Any owned country can target this nation.'}</p></div>`;}
function feed(g){return `<section class="panel"><div class="activity-head"><h3>Field reports</h3><div class="commentary-actions"><span class="badge live">${state.watch?'Recorded':'Campaign log'}</span>${cloudEnabled&&!state.watch?btn('Generate commentary','request-commentary','btn-sm'):""}</div></div>${cloudEnabled&&!state.watch?`<p class="commentary-feed-status" data-ai-feed-status role="status"></p>`:""}<div class="activity-feed">${g.events.slice(-12).reverse().map(event=>`<div class="activity-row"><span class="activity-symbol">${icon(event.type==='dice'?'swords':event.type==='reinforce'?'users':event.type==='transfer'?'transfer':event.type==='conquest'?'shield':'globe')}</span><div class="activity-copy">${escape(reportText(g,event))}<p class="ai-commentary" data-commentary-event="${escape(event.id)}">${event.commentary?`AI commentary: ${escape(event.commentary)}`:''}</p><span class="event-meta">ROUND ${String(event.round).padStart(2,'0')} / ${event.type.toUpperCase()}</span></div><span class="activity-time">${new Date(event.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span></div>`).join('')}</div></section>`;}
function battleLossSummary(g,battle){
  if(g.presentationPending||!battle?.pairs?.length)return '';
  const from=g.countries.find(country=>country.code===battle.from),to=g.countries.find(country=>country.code===battle.to);
  if(!from||!to)return '';
  const attackerLoss=battle.attackerLoss??battle.pairs.filter(pair=>pair.a<pair.d).length;
  const defenderLoss=battle.defenderLoss??battle.pairs.filter(pair=>pair.a>pair.d).length;
  return `<div class="commentary battle-loss-summary">Phase ${battle.phase}: ${escape(from.name)} lost ${attackerLoss}; ${escape(to.name)} lost ${defenderLoss}. ${attackerLoss===0&&defenderLoss===0?'A stand-off. Both armies hold.':''}</div>`;
}
function actionPanel(g){
  const e=new GameEngine(g),human=e.current===0,own=owned(g),origin=g.countries.find(c=>c.code===state.origin)||own[0],target=g.countries.find(c=>c.code===state.target),viewOnly=!!state.watch;
  if(g.presentationPending){const a=g.countries.find(c=>c.code===g.battle.from),d=g.countries.find(c=>c.code===g.battle.to);return `<section class="panel action-panel"><div class="eyebrow">Battle in progress</div><h2>${a.name}<br><span class="muted">vs ${d.name}</span></h2><div class="battle-summary"><span>${a.flag} ${a.army} soldiers</span><span>${d.flag} ${d.army} soldiers</span></div>${dicePairs(g.battle.pairs)}<div class="commentary" role="status">Rolling dice. Results appear when they settle.</div><button class="btn btn-primary btn-full" disabled>Rolling dice...</button></section>`;}
  if(viewOnly)return `<section class="panel action-panel"><div class="eyebrow">From the sidelines</div><h2>A world in motion.</h2><p class="explain">You are viewing a read-only snapshot of this campaign. Inspect any country and explore the recorded battle history.</p><div class="notice">${icon('eye')}<span><strong>Viewing only</strong><br>Campaign controls belong to the owner.</span></div><a href="#history/watch" class="btn btn-full">${icon('history')} Battle replay</a><a href="#setup" class="btn btn-primary btn-full">Start your own campaign ${icon('arrow')}</a><p class="action-helper">Shared demo links contain a snapshot, rather than a live connection.</p></section>`;
  if(g.winner!==null)return `<section class="panel action-panel"><div class="eyebrow">The final chapter</div><div class="result-emblem">${g.winner===0?'♜':'⌖'}</div><h2 class="result-title">${g.winner===0?'The world is yours.':`${commanders[g.winner]} takes the world.`}</h2><p class="explain">Ten countries. One commander. This campaign reached its conclusion in ${g.round} rounds.</p><a href="#history/${g.id}" class="btn btn-full">${icon('history')} Replay the campaign</a><a href="#setup" class="btn btn-primary btn-full">A new beginning ${icon('arrow')}</a></section>`;
  if(!own.length&&!state.watchNPC)return `<section class="panel action-panel"><div class="eyebrow">Your campaign continues</div><h2>A final stand.</h2><p class="explain">Your last country has fallen. Stay to watch the remaining commanders compete for the world, or begin another campaign.</p>${btn(`${icon('eye')} Continue watching`,'continue-npcs','btn-primary btn-full')}<a href="#setup" class="btn btn-full">Start again</a></section>`;
  if(!human)return `<section class="panel action-panel"><div class="eyebrow">Strategic opponent / P${e.current+1}</div><div class="npc-emblem"><img src="./assets/compass.svg" alt=""></div><h2>${nameOf(e.current)} is moving.</h2><div class="signal-line"><span class="signal-dot"></span> ${state.fast?'FAST PLAYBACK':'SIMULATING NEXT MOVE'}</div><div class="commentary">${escape(state.npcNote||'Surveying the board and evaluating the next opportunity.')}</div>${g.battle?dicePairs(g.battle.pairs):g.lastBattle?dicePairs(g.lastBattle.pairs):''}${battleLossSummary(g,g.battle||g.lastBattle)}${g.lastBattle?.outcome==='conquest'?`<div class="recent-conquest">${escape(g.lastBattle.country)} conquered · +${g.lastBattle.reward} soldiers earned.</div>`:''}${btn(`${icon(state.fast?'pause':'fast')} ${state.fast?'Normal speed':'Fast forward'}`,'fast','btn-full')}<p class="action-helper">Every decision, dice roll and outcome remains in the campaign log.</p></section>`;
  if(g.budget){const used=Object.values(state.allocations).reduce((a,b)=>a+b,0),remaining=g.budget-used;return `<section class="panel action-panel"><div class="eyebrow">01 / Start of your turn</div><h2>Reinforce your position.</h2><p class="explain">${own.length} controlled ${own.length===1?'country grants':'countries grant'} ${g.budget} new soldiers. Place them where your next move begins.</p><div class="budget"><div><div class="caption">Available this turn</div><div class="budget-number">+${g.budget}</div></div><div><div class="caption">Remaining</div><div class="budget-number" style="text-align:right">${remaining}</div></div></div>${own.map(c=>`<div class="allocation-row"><div class="allocation-name">${c.flag} ${c.name}<div class="small">${c.army} → ${c.army+(state.allocations[c.code]||0)} soldiers</div></div><div class="stepper"><button data-action="allocate-minus" data-code="${c.code}" aria-label="Remove one reinforcement from ${c.name}" ${(state.allocations[c.code]||0)===0?'disabled':''}>−</button><output>+${state.allocations[c.code]||0}</output><button data-action="allocate-plus" data-code="${c.code}" aria-label="Add one reinforcement to ${c.name}" ${remaining===0?'disabled':''}>+</button></div></div>`).join('')}${btn('Confirm reinforcements','confirm-reinforce','btn-primary btn-full',remaining!==0?'disabled':'')}${btn('Deploy to strongest country','auto-allocate','btn-ghost btn-full')}<p class="action-helper">Allocate every soldier before moving or attacking.</p></section>`;}
  if(g.battle){const a=g.countries.find(c=>c.code===g.battle.from),d=g.countries.find(c=>c.code===g.battle.to);return `<section class="panel action-panel"><div class="eyebrow">04 / Battle in progress</div><h2>${a.name}<br><span class="muted">vs ${d.name}</span></h2><div class="battle-summary"><span>${a.flag} ${a.army} soldiers</span><span>${d.flag} ${d.army} soldiers</span></div>${g.battle.pairs.length?dicePairs(g.battle.pairs):'<div class="commentary">The armies face each other. Your first roll will decide the opening exchange.</div>'}${battleLossSummary(g,g.battle)}${btn(`${icon('play')} Roll ${g.battle.phase?'next phase':'the dice'}`,'roll','btn-primary btn-full')}${btn('Stop attack & end turn','stop-attack','btn-ghost btn-full')}<p class="action-helper">Paired dice · Ties cost no soldiers · Keep one soldier behind</p></section>`;}
  if(state.action==='transfer'){const destinations=own.filter(c=>c.code!==origin?.code);return `<section class="panel action-panel"><div class="eyebrow">02 / Reposition</div><h2>Strength in the right place.</h2><p class="explain">Move soldiers between your countries. Leave at least one soldier behind.</p><div class="field-group"><label for="transfer-from" class="field-label">From</label><select id="transfer-from" class="field">${own.map(c=>`<option value="${c.code}" ${origin?.code===c.code?'selected':''}>${c.flag} ${c.name} · ${c.army}</option>`).join('')}</select></div><div class="field-group"><label for="transfer-to" class="field-label">To</label><select id="transfer-to" class="field">${destinations.map(c=>`<option value="${c.code}">${c.flag} ${c.name} · ${c.army}</option>`).join('')}</select></div><div class="field-group"><label for="transfer-count" class="field-label">Soldiers to transfer</label><input class="field" id="transfer-count" type="number" min="1" max="${Math.max(1,(origin?.army||1)-1)}" value="1"></div>${btn(`${icon('transfer')} Transfer soldiers`,'confirm-transfer','btn-teal btn-full',!destinations.length||origin.army<2?'disabled':'')}${btn('Return to planning','planning','btn-ghost btn-full')}</section>`;}
  if(g.lastBattle){const win=g.lastBattle.outcome==='conquest';return `<section class="panel action-panel"><div class="eyebrow">${win?'A new foothold':'Battle concluded'}</div><h2>${win?'A nation joins your command.':'The frontier holds.'}</h2>${dicePairs(g.lastBattle.pairs)}<div class="recent-conquest">${win?`${g.lastBattle.country} conquered · +${g.lastBattle.reward} soldiers earned.`:'Your remaining soldiers hold their position.'}</div><p class="explain">${win?'One earned soldier garrisons the new territory. Transfer more soldiers to strengthen it, or pass command to the next participant.':'You have used your attack for this turn. Reposition your remaining troops or end your turn.'}</p>${win?btn('Transfer soldiers','transfer','btn-teal btn-full'):''}${btn(`End turn ${icon('arrow')}`,'end-turn','btn-primary btn-full')}</section>`;}
  return `<section class="panel action-panel"><div class="eyebrow">03 / Your next move</div><h2>The world is within reach.</h2><p class="explain">Choose your attacking nation, then set your sights on any rival country.</p><div class="field-group"><label for="attack-from" class="field-label">Your attacking country</label><select id="attack-from" class="field">${own.map(c=>`<option value="${c.code}" ${origin?.code===c.code?'selected':''}>${c.flag} ${c.name} · ${c.army}</option>`).join('')}</select></div><div class="field-group"><label for="attack-to" class="field-label">Target country</label><select id="attack-to" class="field">${g.countries.filter(c=>c.owner!==0).map(c=>`<option value="${c.code}" ${target?.code===c.code?'selected':''}>${c.flag} ${c.name} · ${c.army}</option>`).join('')}</select></div>${origin?`<div class="selected-unit"><span class="flag">${origin.flag}</span><div class="unit-meta">${origin.name}<span>${Math.max(0,origin.army-1)} available to attack</span></div><span class="unit-army">${origin.army}</span></div>`:''}${btn(`${icon('swords')} Launch attack`,'start-attack','btn-danger btn-full',!origin||origin.army<2||g.attackUsed?'disabled':'')}${btn('Skip this turn','end-turn','btn-ghost btn-full')}<p class="action-helper">One target per turn. Keep rolling until you conquer, stop, or have one soldier left.</p></section>`;
}

function gameView(g){const e=new GameEngine(g),own=owned(g),soldiers=own.reduce((n,c)=>n+c.army,0),turn=turnMotion(motionFrame);if(!state.selected)state.selected=own[0]?.code||g.countries[0].code;if(!state.origin||!own.find(c=>c.code===state.origin))state.origin=own.slice().sort((a,b)=>b.army-a.army)[0]?.code;if(!state.target||g.countries.find(c=>c.code===state.target)?.owner===0)state.target=g.countries.filter(c=>c.owner!==0).sort((a,b)=>a.army-b.army)[0]?.code;return `<div class="game-shell">${nav('',true)}<main><div class="game-heading"><div><div class="eyebrow">${state.watch?'Shared campaign / Viewing only':'Active campaign / Single player'} ${difficultyBadge(g.difficulty)}</div><h1>${escape(g.name)}</h1></div><div class="nav-actions">${btn(`${icon('fast')} ${state.fast?'Normal speed':'Fast forward'}`,'fast','btn-sm',state.watch?'disabled':'')}${btn(`${icon('copy')} Share`,'share','btn-sm',`data-id="${g.id}"`)}<a href="#history/${state.watch?'watch':g.id}" class="btn btn-sm">${icon('history')} Replay</a></div></div>${state.watch?`<div class="notice watch-notice">${icon('eye')}<span><strong>Viewing only.</strong> This link shows a recorded snapshot. You can inspect the board and replay its history.</span></div>`:''}<div class="game-stats"><div class="game-stat"><div class="caption">Current round</div><div class="value">${String(g.round).padStart(2,'0')} <span class="small muted">/ ongoing</span></div></div><div class="game-stat"><div class="caption">Current turn</div><div class="value"><span class="dot" style="background:${colours[e.current]}"></span>${nameOf(e.current)}</div></div><div class="game-stat"><div class="caption">Your countries</div><div class="value">${own.length} <span class="small muted">/ 10</span></div></div><div class="game-stat"><div class="caption">Your army</div><div class="value">${soldiers} <span class="small muted">soldiers</span></div></div></div><div class="turn-order"><span>TURN ORDER</span>${g.order.map(p=>`<span class="turn-person ${e.current===p?'current':''} ${!owned(g,p).length?'eliminated':''} ${e.current===p?turn.className:''}" style="${e.current===p?turn.style:''}">P${p+1} ${nameOf(p)}</span>`).join('')}</div><div class="board-grid">${roster(g)}<div class="map-and-activity">${theatre(g.countries,{interactive:true,selected:state.selected,origin:state.origin,target:state.target,motion:motionFrame})}<div class="board-actions">${btn(`${icon('transfer')} Transfer soldiers`,'transfer','btn-teal',e.current!==0||g.budget||g.battle||own.length<2||state.watch?'disabled':'')}${btn(`${icon('skip')} Skip turn`,'end-turn','',e.current!==0||g.budget||g.battle||state.watch?'disabled':'')}${btn(`${icon('info')} Rules`,'help','btn-ghost')}</div>${feed(g)}</div>${actionPanel(g)}</div><div class="game-save-line"><span><i class="saved-dot"></i> ${state.watch?'Shared snapshot':'Saved on this device'} · ${state.fast?'Fast playback':'Normal playback'}</span><span>${campaignPopulationLabel(g)}</span><span>Every country. Every decision.</span></div></main></div>`;}

function history(g){const events=g.events,index=Math.min(state.replay,events.length-1),event=events[index];if(!event)return dashboard();const rolling=rollPending(motionFrame),board=g.countries.map(c=>({...c,...(rolling?motionFrame.roll.beforeBoard:event.board).find(x=>x.code===c.code)}));return `<div class="shell">${nav()}<main><div class="page-heading"><div><div class="eyebrow">Campaign archive / Battle replay</div><h1>Every move leaves a mark.</h1><p>${escape(g.name)} · ${difficultyFor(g.difficulty).label} difficulty · Recorded decisions, dice and turning points.</p></div><div class="history-actions"><a href="#${state.watch?'watch/'+encodeSnapshot(g):'game/'+g.id}" class="btn btn-sm">${icon('back')} Back to board</a></div></div><div class="history-grid"><div>${theatre(board,{motion:motionFrame})}<input type="range" id="history-range" class="history-slider" min="0" max="${events.length-1}" value="${index}" aria-label="Replay event"><div class="history-controls">${btn(icon('back'),'replay-prev','',`aria-label="Previous event" ${index===0?'disabled':''}`)}${btn(`${icon(replayTimer?'pause':'play')} ${replayTimer?'Pause':'Play replay'}`,'replay-play','btn-primary')}<span class="counter">${String(index+1).padStart(2,'0')} / ${String(events.length).padStart(2,'0')}</span>${btn(icon('chevron'),'replay-next','',`aria-label="Next event" ${index===events.length-1?'disabled':''}`)}</div><div class="notice">${icon('lock')}<span>Replay explores the record. Your saved campaign stays at its current position.</span></div></div><section class="panel history-event"><div class="eyebrow">Round ${event.round} / ${event.type}</div><h2>${rolling?'The dice are rolling.':event.type==='conquest'?'A border redrawn.':event.type==='dice'?'The dice decide.':event.type==='reinforce'?'Strength takes shape.':'A move worth remembering.'}</h2><p>${rolling?'Results appear when the dice settle.':escape(reportText(g,event))}</p><p class="ai-commentary" ${rolling?'hidden':''} data-commentary-event="${escape(event.id)}">${event.commentary?`AI commentary: ${escape(event.commentary)}`:''}</p>${event.pairs?dicePairs(event.pairs):''}<div class="timeline-list">${events.map((ev,i)=>`<button class="timeline-event ${i===index?'active':''}" data-action="replay-select" data-index="${i}"><span class="event-index">${String(i+1).padStart(2,'0')}</span><span>${escape(reportText(g,ev))}</span></button>`).join('')}</div></section></div></main>${footer()}</div>`;}

function encodeSnapshot(g){const clean={...g,events:g.events.slice(-60)};return btoa(unescape(encodeURIComponent(JSON.stringify(clean)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decodeSnapshot(text){
  if(!text||text.length>180000)throw new Error('This shared snapshot is missing or too large.');
  const data=JSON.parse(decodeURIComponent(escapeBinary(atob(text.replace(/-/g,'+').replace(/_/g,'/')))));
  if(!data||!Array.isArray(data.countries)||data.countries.length!==10||!Array.isArray(data.events)||!Array.isArray(data.order)||data.order.length!==10||new Set(data.order).size!==10||data.order.some(n=>!Number.isInteger(n)||n<0||n>9))throw new Error('This campaign link is invalid.');
  for(const c of data.countries){const known=findCountry(c.code);if(!known||!Number.isInteger(c.army)||c.army<1||c.army>100000||!Number.isInteger(c.owner)||c.owner<0||c.owner>9)throw new Error('Invalid country in shared snapshot.');Object.assign(c,{name:known.name,flag:known.flag,id:known.id,lon:known.lon,lat:known.lat,...savedCountryPopulation(c)});}
  if(new Set(data.countries.map(c=>c.code)).size!==10||!Number.isInteger(data.position)||data.position<0||data.position>=10||!Number.isInteger(data.round)||data.round<1)throw new Error('Invalid turn in shared snapshot.');
  const allowedTypes=new Set(['campaign','turn','decision','attack','dice','conquest','reinforce','transfer','elimination','victory','retreat','held']);
  data.id=/^[a-zA-Z0-9-]{1,60}$/.test(data.id)?data.id:'shared-campaign';data.name=String(data.name||'Shared campaign').slice(0,60);data.winner=Number.isInteger(data.winner)&&data.winner>=0&&data.winner<10?data.winner:null;
  data.difficulty=difficultyFor(data.difficulty).id;
  data.events=data.events.slice(-60).map((event,i)=>({id:`shared-${i}`,type:allowedTypes.has(event?.type)?event.type:'campaign',text:String(event?.text||'Recorded campaign event').slice(0,500),round:Number.isInteger(event?.round)&&event.round>0?event.round:data.round,player:Number.isInteger(event?.player)?event.player:0,at:Number.isFinite(event?.at)?event.at:Date.now(),from:data.countries.some(c=>c.code===event?.from)?event.from:undefined,to:data.countries.some(c=>c.code===event?.to)?event.to:undefined,amount:Number.isInteger(event?.amount)&&event.amount>0&&event.amount<=100000?event.amount:undefined,attackerLoss:Number.isInteger(event?.attackerLoss)&&event.attackerLoss>=0&&event.attackerLoss<=100000?event.attackerLoss:undefined,defenderLoss:Number.isInteger(event?.defenderLoss)&&event.defenderLoss>=0&&event.defenderLoss<=100000?event.defenderLoss:undefined,pairs:Array.isArray(event?.pairs)?event.pairs.slice(0,200).filter(p=>Number.isInteger(p?.a)&&p.a>=1&&p.a<=6&&Number.isInteger(p?.d)&&p.d>=1&&p.d<=6).map((p,j)=>({index:j+1,a:p.a,d:p.d})):undefined,board:data.countries.map(c=>{const record=Array.isArray(event?.board)?event.board.find(x=>x?.code===c.code):null;return {code:c.code,owner:Number.isInteger(record?.owner)&&record.owner>=0&&record.owner<10?record.owner:c.owner,army:Number.isInteger(record?.army)&&record.army>=0&&record.army<=100000?record.army:c.army};})}));
  if(!data.events.length)data.events=[{id:'snapshot',type:'campaign',text:'Campaign snapshot received.',round:data.round,at:Date.now(),board:data.countries.map(c=>({code:c.code,owner:c.owner,army:c.army}))}];
  return data;
}
const escapeBinary=text=>Array.from(text,ch=>'%'+ch.charCodeAt(0).toString(16).padStart(2,'0')).join('');
function route(){clearInterval(replayTimer);replayTimer=null;state.watchNPC=false;state.npcNote='';const hash=location.hash.slice(1)||'welcome';if(hash==='how-to-play'){if(!app.innerHTML)render();showHelp();return;}motionDirector.reset();const [view,id]=hash.split('/');multiplayer.route(view==='multiplayer'?(id||''):null);if(view!=='history'&&view!=='watch'){state.watch=null;}state.view=view;state.gameId=id;state.action='planning';state.selected=null;state.origin=null;state.target=null;state.allocations={};if(view==='watch'){try{state.watch=decodeSnapshot(id);state.gameId=state.watch.id;state.view='game';}catch(error){state.watch=null;state.view='welcome';notify(error.message);}}if(view==='history'){state.replay=0;if(id==='watch'&&!state.watch){state.view='campaigns';}}render();window.scrollTo({top:0,behavior:'instant'});if(state.view==='game'&&!state.watch)queueMicrotask(runNPCs);}
function render(){
  const g=currentGame();
  const awaitingCampaign=(state.view==='game'||state.view==='history')&&(!g||(cloudEnabled&&!cloudReady&&!state.watch));
  if(awaitingCampaign&&!g&&(!cloudEnabled||cloudReady)){state.view='campaigns';notify('This campaign is not saved on this device.');}
  if(g&&!awaitingCampaign&&['game','history','multiplayer'].includes(state.view))motionFrame=motionDirector.frame(g,{view:state.view,replay:state.replay,fast:state.fast,watch:!!state.watch,localPlayer:state.view==='multiplayer'?multiplayer.playerSeat:0});
  else{motionDirector.reset();motionFrame=null;}
  app.innerHTML=awaitingCampaign?dashboard():state.view==='multiplayer'?`<div class="shell">${nav('multiplayer')}<main>${multiplayer.render()}</main>${footer()}</div>`:state.view==='welcome'?welcome():state.view==='campaigns'?dashboard():state.view==='setup'?setup():['signin','signup','reset'].includes(state.view)?auth(state.view):state.view==='game'?gameView(presentationGame(g,motionFrame)):state.view==='history'?history(g):welcome();
  if(motionFrame)motionDirector.mount(app,motionFrame,{onSettled:render});
  audioDirector.observe(g,{view:state.view==='multiplayer'?'game':state.view,replay:state.replay,fast:state.fast,watch:!!state.watch},motionFrame);
  syncAudioControls();syncAIControls();syncNicknameControls();
  document.title=state.view==='game'&&g?`${g.name} — Meridian Conquest`:'Meridian Conquest — Your world. Your next move.';
}

function showHelp(){const dialog=document.getElementById('help-dialog');dialog.innerHTML=`<div class="help-head"><div><div class="eyebrow">Rules of engagement</div><h2 id="help-title">A world under your command.</h2></div><button class="icon-button" data-action="close-help" aria-label="Close instructions">${icon('close')}</button></div><div class="help-content">${[['Choose your foothold','Start with one country. Nine other countries are assigned to strategic NPCs. The first participant is chosen randomly.'],['Reinforce and reposition','From round two, receive two soldiers per controlled country at the start of your turn. Move soldiers between your countries while leaving one behind.'],['Choose your target','Attack any enemy country from an owned country with at least two soldiers. You have one attack against one target per turn.'],['Let the dice decide','Both sides roll as many paired dice as the smaller available force. Attackers leave one soldier behind. The higher roll defeats one soldier; ties cause no loss.'],['Know when to stop','Continue rolling, stop and end your turn, or conquer the target. The attack also ends when the attacker has only one soldier.'],['Conquer the world','Conquest earns max(2, half the country’s original strength rounded down). Control all ten countries to win.']].map(([title,text],i)=>`<div class="help-step"><span>0${i+1}</span><div><h3>${title}</h3><p>${text}</p></div></div>`).join('')}<div class="notice">${icon('info')}<span>Starting armies use a validated Worldometers population snapshot. Existing campaigns keep their original populations and rewards. ${cloudEnabled?'Sign in to play and sync your campaigns.':'Account screens preview the future sign-in flow.'}</span></div></div>`;if(!dialog.open)dialog.showModal();}

const wait=(duration=2500)=>new Promise(resolve=>setTimeout(resolve,state.fast?Math.max(750,Math.round(duration/3)):duration));
async function defendNpcHoldings(e,active){
  for(const move of e.npcTransfers()){
    if(!active())return false;
    state.npcNote=move.reason;e.event('decision',move.reason);
    e.transfer(move.from,move.to,move.amount);save();render();await wait();
  }
  return active();
}
async function runNPCs(){
  const g=currentGame();if((cloudEnabled&&(!cloud?.user||!cloudReady))||!g||npcBusy||state.watch||state.view!=='game'||g.winner!==null||new GameEngine(g).current===0||(!owned(g).length&&!state.watchNPC))return;
  npcBusy=true;
  const active=()=>currentGame()===g&&state.view==='game'&&!state.watch&&g.winner===null;
  try{
    let turns=0;
    while(active()&&new GameEngine(g).current!==0&&(owned(g).length||state.watchNPC)&&turns++<200){
      const e=new GameEngine(g),participant=e.current;e.beginTurn();
      if(g.budget){const plan=e.npcReinforcements();state.npcNote=plan.reason;e.event('decision',state.npcNote);e.reinforce(plan.allocations);save();render();await wait();if(!active())break;}
      if(!g.battle&&e.owned().length>1&&!await defendNpcHoldings(e,active))break;
      if(!g.battle&&!g.attackUsed){const plan=e.npcPlan();state.npcNote=plan.reason;e.event('decision',`${nameOf(participant)}: ${plan.reason}`);save();render();await wait();if(!active())break;if(plan.from){e.startAttack(plan.from.code,plan.to.code);state.npcNote=`${plan.from.name} is preparing to attack ${plan.to.name}. The opening dice roll is next.`;save();render();await wait();if(!active())break;}}
      while(active()&&g.battle&&e.current===participant){
        const decision=e.npcBattleDecision();
        state.npcNote=decision.reason;e.event('decision',state.npcNote);
        if(!decision.continue){save();render();await wait();if(!active())break;e.stopAttack();state.npcNote='';save();render();await wait();break;}
        const outcome=e.roll();save();render();await wait(outcome.finished?3500:3000);
        if(outcome.conquered&&active()&&!await defendNpcHoldings(e,active))break;
      }
      if(!active())break;
      if(e.current===participant&&!g.battle){e.endTurn();state.npcNote='';save();render();await wait();}
    }
    if(turns>=200)notify('Playback paused after 200 turns. Continue watching to resume.');
  }catch(error){notify(error.message);}
  finally{npcBusy=false;state.npcNote='';if(new GameEngine(g).current===0)state.fast=false;if(state.view==='game'&&currentGame()&&currentGame()!==g)queueMicrotask(runNPCs);if(currentGame()===g&&state.view==='game')render();}
}

async function shareGame(g){
  if(!g)return;
  const url=`${location.origin}${location.pathname}#watch/${encodeSnapshot(g)}`;
  try{await navigator.clipboard.writeText(url);notify('Read-only campaign snapshot copied. This link does not update live.');}
  catch{const dialog=document.getElementById('help-dialog');dialog.innerHTML=`<div class="help-head"><h2 id="help-title">Share this campaign snapshot</h2><button class="icon-button" data-action="close-help" aria-label="Close share dialog">${icon('close')}</button></div><div class="help-content"><p class="small muted" style="margin:18px 0">Copy this read-only snapshot link. It preserves the current position and recorded events.</p><textarea class="field" style="height:100px" readonly aria-label="Snapshot URL">${escape(url)}</textarea></div>`;dialog.showModal();dialog.querySelector('textarea').select();}
}

document.addEventListener('click',async event=>{
  if(await multiplayer.handleClick(event))return;
  const button=event.target.closest('[data-action]');
  if(!button){if(event.target.closest('a[href]'))audioDirector.cue('click');return;}
  if(button.disabled)return;
  const action=button.dataset.action,g=currentGame();
  try{
    if(rollPending(motionFrame)&&['roll','stop-attack','end-turn','transfer','confirm-transfer','start-attack','confirm-reinforce','continue-npcs'].includes(action))return;
    if(action==='request-commentary'){const count=cloud?.requestCommentary(g)||0;notify(count?'Gemini commentary requested for recent events.':'Recent events already have the latest commentary.');syncAIControls();return;}
    if(action==='retry-campaigns'){if(!cloud){location.reload();return;}await cloud.reload();return;}
    if(action==='clear-campaign-filters'){state.filter='all';state.search='';render();return;}
    if(action==='sign-out'){await cloud.signOut();location.hash='welcome';return;}
    if(cloudEnabled&&['create-game','fast','continue-npcs','allocate-plus','allocate-minus','auto-allocate','confirm-reinforce','confirm-transfer','start-attack','roll','stop-attack','end-turn'].includes(action)&&(!cloud?.user||!cloudReady)){
      notify(cloud?.user?'Your campaigns are still loading.':'Sign in to play and save your campaigns.');if(!cloud?.user)location.hash='signin';return;
    }
    if(action==='settings'){await audioDirector.unlock();syncSettingsControls();syncAudioControls();syncAIControls();document.getElementById('settings-dialog').showModal();return;}
    if(action==='close-settings'){document.getElementById('settings-dialog').close();return;}
    if(action==='test-audio'){await audioDirector.unlock();audioDirector.cue('turn');return;}
    if(!['roll','start-attack','confirm-transfer','confirm-reinforce'].includes(action))audioDirector.cue('click');
    if(action==='motion'){
      motionChoice=motionDirector.reducedMotion?'full':'reduced';
      try{localStorage.setItem('meridian-motion-preference',motionChoice);}catch{}
      motionDirector.setReducedMotion(resolveReducedMotion(motionChoice,motionPreference.matches));
      document.documentElement.dataset.motion=motionDirector.reducedMotion?'reduced':'full';
      syncSettingsControls();render();notify(motionDirector.reducedMotion?'Reduced motion enabled.':'Full map animations enabled.');return;
    }
    if(action==='help'){showHelp();return;}
    if(action==='close-help'){document.getElementById('help-dialog').close();if(location.hash==='#how-to-play')window.history.replaceState(null,'',`#${state.view}${state.gameId?'/'+state.gameId:''}`);return;}
    if(action==='account'){syncSettingsControls();syncAudioControls();syncAIControls();document.getElementById('settings-dialog').showModal();document.getElementById('player-nickname').focus();return;}
    if(action==='filter'){state.filter=button.dataset.filter;render();return;}
    if(action==='setup-country'){state.setupStart=button.dataset.code;state.setupGame=GameEngine.create(state.setupName,state.setupStart,false,state.setupDifficulty,profile?.name);render();return;}
    if(action==='redraw-roster'){state.setupGame=GameEngine.create(state.setupName,state.setupStart,false,state.setupDifficulty,profile?.name);render();notify('Nine distinct rivals redrawn.');return;}
    if(action==='create-game'){const name=state.setupName.trim();if(name.length<3){notify('Give your campaign a name of at least three characters.');document.getElementById('session-name').focus();return;}const created=state.setupGame;created.name=name;created.difficulty=difficultyFor(state.setupDifficulty).id;games.unshift(created);state.setupGame=null;save();location.hash=`game/${created.id}`;return;}
    if(action==='share'){await shareGame(state.watch||games.find(x=>x.id===button.dataset.id)||g);return;}
    if(action.startsWith('replay-')){
      const last=g.events.length-1;
      if(action==='replay-select')state.replay=Number(button.dataset.index);
      if(action==='replay-prev')state.replay=Math.max(0,state.replay-1);
      if(action==='replay-next')state.replay=Math.min(last,state.replay+1);
      if(action==='replay-play'){if(replayTimer){clearInterval(replayTimer);replayTimer=null;}else{if(state.replay>=last)state.replay=0;replayTimer=setInterval(()=>{if(state.view!=='history'){clearInterval(replayTimer);replayTimer=null;return;}state.replay++;if(state.replay>=last){state.replay=last;clearInterval(replayTimer);replayTimer=null;}render();},1000);}}
      render();return;
    }
    if(!g)return;
    if(action==='select-country'){const c=g.countries.find(c=>c.code===button.dataset.code);if(!c)return;state.selected=c.code;if(c.owner===0&&!g.battle)state.origin=c.code;else if(c.owner!==0&&!g.battle)state.target=c.code;render();return;}
    if(state.watch)return;
    if(action==='fast'){state.fast=!state.fast;render();queueMicrotask(runNPCs);return;}
    if(action==='continue-npcs'){state.watchNPC=true;render();queueMicrotask(runNPCs);return;}
    const e=engine();if(e.current!==0||g.winner!==null)return;
    if(action==='allocate-plus'){const used=Object.values(state.allocations).reduce((a,b)=>a+b,0);if(used<g.budget)state.allocations[button.dataset.code]=(state.allocations[button.dataset.code]||0)+1;}
    if(action==='allocate-minus')state.allocations[button.dataset.code]=Math.max(0,(state.allocations[button.dataset.code]||0)-1);
    if(action==='auto-allocate'){state.allocations={[e.owned().sort((a,b)=>b.army-a.army)[0].code]:g.budget};}
    if(action==='confirm-reinforce'){e.reinforce(state.allocations);state.allocations={};state.action='planning';notify('Reinforcements deployed. Your next move is ready.');}
    if(action==='transfer'){if(g.budget||g.battle||owned(g).length<2){notify('Transfers need two owned countries and a clear planning phase.');return;}state.action='transfer';}
    if(action==='planning')state.action='planning';
    if(action==='confirm-transfer'){e.transfer(document.getElementById('transfer-from').value,document.getElementById('transfer-to').value,Number(document.getElementById('transfer-count').value));state.action='planning';notify('Soldiers transferred.');}
    if(action==='start-attack'){e.startAttack(document.getElementById('attack-from').value,document.getElementById('attack-to').value);state.action='battle';}
    if(action==='roll'){const result=e.roll();if(result.conquered)notify('A new nation is under your command.');}
    if(action==='stop-attack'){e.stopAttack();state.action='planning';state.allocations={};}
    if(action==='end-turn'){e.endTurn();state.action='planning';state.allocations={};}
    save();render();if(action==='end-turn'||action==='stop-attack')queueMicrotask(runNPCs);
  }catch(error){audioDirector.cue('invalid');notify(error.message);}
});

document.addEventListener('input',event=>{
  const input=event.target;
  if(input.id==='audio-music'||input.id==='audio-effects'){audioDirector.setSettings({[input.id==='audio-music'?'music':'effects']:Number(input.value)/100});return;}
  if(input.id==='campaign-search'){state.search=input.value;document.getElementById('campaign-results').innerHTML=campaignResults();document.getElementById('campaign-result-count').textContent=`${filteredGames().length} SESSIONS`;}
  if(input.id==='session-name')state.setupName=input.value;
  if(input.id==='country-search'){state.setupSearch=input.value;document.getElementById('country-options').innerHTML=setupOptions();}
  if(input.id==='history-range'){state.replay=Number(input.value);render();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='ai-enabled'){cloud?.setCommentaryEnabled(event.target.checked);syncAIControls();return;}
  if(event.target.id==='audio-muted'){audioDirector.setSettings({muted:event.target.checked});return;}
  if(event.target.name==='difficulty'&&state.view==='setup'){
    state.setupDifficulty=difficultyFor(event.target.value).id;
    if(state.setupGame)state.setupGame.difficulty=state.setupDifficulty;
    render();document.getElementById(`difficulty-${state.setupDifficulty}`)?.focus({preventScroll:true});return;
  }
  if(['attack-from','transfer-from'].includes(event.target.id)){state.origin=event.target.value;state.selected=event.target.value;render();}
  if(event.target.id==='attack-to'){state.target=event.target.value;state.selected=event.target.value;render();}
});
document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('.map-marker[role="button"]')){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
document.addEventListener('submit',async event=>{
  if(event.target.id==='nickname-form'){event.preventDefault();await savePlayerNickname(event.target);return;}
  if(event.target.matches('[data-room-form]')){event.preventDefault();await multiplayer.submit(event.target);return;}
  if(event.target.id!=='auth-form')return;event.preventDefault();
  const form=event.target,values=new FormData(form),kind=form.dataset.kind;
  let signupNickname;
  if(kind==='signup'){
    try{signupNickname=normalizeNickname(values.get('name'));}
    catch(error){document.getElementById('form-error').textContent=error.message;return;}
  }
  if(cloudEnabled){
    const errorNode=document.getElementById('form-error'),submit=form.querySelector('[type="submit"]');
    if(!cloud){errorNode.textContent='Firebase is still connecting. Please try again.';return;}
    if(kind==='signup'&&values.get('password')!==values.get('confirm')){errorNode.textContent='The passwords do not match.';return;}
    submit.disabled=true;
    try{
      await cloud.authenticate(kind,values);form.reset();
      if(kind==='reset')notify('If this account exists, a password reset email has been requested.');
      else{let destination='campaigns';try{destination=sessionStorage.getItem('meridian-room-return')||destination;sessionStorage.removeItem('meridian-room-return');}catch{}location.hash=destination;notify('Signed in. Your campaigns are loading.');}
    }catch(error){
      errorNode.textContent=error.code==='auth/email-already-in-use'?'This email already has an account. Try signing in.':error.code==='auth/network-request-failed'?'Cannot connect. Check your internet connection.':'Unable to sign in or complete the request. Check your details and try again.';
    }finally{submit.disabled=false;}
    return;
  }
  if(kind==='reset'){notify('Reset flow previewed. Email delivery will be available once authentication is connected.');form.reset();return;}
  if(kind==='signup'&&values.get('password')!==values.get('confirm')){document.getElementById('form-error').textContent='The passwords do not match. Please check both fields.';return;}
  profile={name:kind==='signup'?signupNickname:'Commander'};
  try{localStorage.setItem('meridian-ui-profile',JSON.stringify(profile));}catch{}
  form.reset();location.hash='campaigns';notify(`Welcome, ${profile.name}. Your preview profile is ready.`);
});
function highlightCountry(code){
  for(const node of app.querySelectorAll('[data-map-country]'))node.classList.toggle('is-hovered',!!code&&node.dataset.mapCountry===code);
}
for(const type of ['pointerover','focusin'])app.addEventListener(type,event=>highlightCountry(event.target.closest('[data-map-country]')?.dataset.mapCountry));
for(const type of ['pointerout','focusout'])app.addEventListener(type,event=>highlightCountry(event.relatedTarget?.closest?.('[data-map-country]')?.dataset.mapCountry));
motionPreference.addEventListener('change',event=>{motionDirector.setReducedMotion(resolveReducedMotion(motionChoice,event.matches));document.documentElement.dataset.motion=motionDirector.reducedMotion?'reduced':'full';render();});
window.addEventListener('hashchange',route);
window.addEventListener('offline',()=>notify('You are offline. The loaded demo and local saves remain available.'));
window.addEventListener('online',()=>notify('Connection restored.'));
document.getElementById('help-dialog').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
document.addEventListener('pointerdown',()=>{audioDirector.unlock();},{passive:true});
document.addEventListener('keydown',event=>{if(!event.ctrlKey&&!event.metaKey&&!event.altKey)audioDirector.unlock();});
document.addEventListener('visibilitychange',()=>audioDirector.setHidden(document.hidden));
document.getElementById('settings-dialog').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
function syncSettingsControls(){
  document.getElementById('settings-motion').innerHTML=motionControl();
  nicknameError='';syncNicknameControls(true);
}
function syncNicknameControls(reset=false){
  const input=document.getElementById('player-nickname'),button=document.querySelector('#nickname-form button'),status=document.getElementById('nickname-status');
  const allowed=!cloudEnabled||Boolean(cloud?.user);
  if(reset)input.value=profile?.name||'';
  input.disabled=!allowed||nicknameSaving;button.disabled=!allowed||nicknameSaving;
  button.textContent=nicknameSaving?'Saving...':'Save nickname';
  status.textContent=nicknameError||(!allowed?'Sign in to save a nickname to your account.':nicknameSaving?'Saving your nickname...':cloudEnabled?'Your account nickname is reused automatically in new multiplayer rooms.':'Saved on this device.');
}
async function savePlayerNickname(form){
  if(nicknameSaving)return;
  nicknameError='';let nickname;
  try{nickname=normalizeNickname(new FormData(form).get('nickname'));}
  catch(error){nicknameError=error.message;syncNicknameControls();return;}
  nicknameSaving=true;syncNicknameControls();
  try{
    if(cloudEnabled){if(!cloud?.user)throw new Error('Sign in first.');await cloud.updateNickname(nickname);}
    else{const next={...profile,name:nickname};localStorage.setItem('meridian-ui-profile',JSON.stringify(next));profile=next;refreshSetupNickname();render();}
    document.getElementById('player-nickname').value=nickname;notify('Player nickname saved.');
  }catch{nicknameError='Your nickname could not be saved. Check your connection and try again.';}
  finally{nicknameSaving=false;syncNicknameControls();}
}
function syncAIControls(){
  const narrator=cloud?.commentary,input=document.getElementById('ai-enabled'),status=document.getElementById('ai-status');
  if(input){input.disabled=!aiConfig.enabled||!cloud;input.checked=Boolean(narrator?.enabled);}
  const localSetupNeeded=['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&!localAppCheckDebugToken&&!globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;
  const message=!aiConfig.enabled?'Gemini commentary is not connected yet.':!narrator?'Connecting...':!narrator.enabled?'AI commentary is off.':localSetupNeeded?'For localhost commentary, run npm run dev and open the address it prints.':narrator.status==='generating'?'Gemini is writing the latest field reports...':narrator.status==='unavailable'?narrator.errorMessage||'AI commentary is temporarily unavailable.':narrator.pending.length?'Commentary is queued for Gemini.':'Gemini is ready. New events are narrated automatically; use Generate commentary for saved events.';
  if(status)status.textContent=message;
  for(const node of app.querySelectorAll('[data-ai-feed-status]'))node.textContent=message;
  for(const node of app.querySelectorAll('[data-action="request-commentary"],[data-room-action="commentary"]'))node.disabled=!cloud?.ready||Boolean(narrator?.running||narrator?.pending.length);
}
function syncAudioControls(){
  const settings=audioDirector.settings;

  for(const name of ['music','effects']){const input=document.getElementById(`audio-${name}`),output=document.getElementById(`audio-${name}-value`);if(input)input.value=String(Math.round(settings[name]*100));if(output)output.textContent=`${Math.round(settings[name]*100)}%`;}
  const mute=document.getElementById('audio-muted');if(mute)mute.checked=settings.muted;
  const status=document.getElementById('audio-status');if(status)status.textContent=settings.muted?'All sound is muted.':audioDirector.unlocked?'Audio ready · Settings saved on this device.':'Sound starts when you interact with the game.';
}
route();
// Reference updates run independently of sign-in, saves, dice and turn playback.
void populations.refresh();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void populations.refresh();});
setInterval(()=>{if(!document.hidden)void populations.refresh();},3600000);
if(cloudEnabled){
  connectCloud({
    onProfile(user){profile={name:playerNickname(user.displayName)};refreshSetupNickname();render();syncNicknameControls();},
    onAIStatus:syncAIControls,
    onLoadState({status,error}){
      campaignLoadState=status;
      campaignLoadError=error?.code==='resource-exhausted'?'Firebase has reached its free usage limit.':error?.code==='permission-denied'?'Access was denied. Try signing out and signing in again.':['unavailable','deadline-exceeded'].includes(error?.code)?'Firebase could not be reached in time. Check your connection and retry.':'Please retry loading your campaigns.';
      render();
    },
    onSession(user,remote,ready){
      cloudReady=ready;
      multiplayer.sessionChanged();
      if(!ready){
        profile=user?{name:playerNickname(user.displayName)}:null;refreshSetupNickname();
        repository=new LocalGameRepository(user?'meridian-cloud-cache-'+user.uid:'meridian-signed-out');
        const cached=user?repository.load():[];
        const visible=new Map(remote.map(game=>[game.id,game]));
        for(const game of Array.isArray(cached)?cached:[])if(!visible.has(game.id)||game.updatedAt>=visible.get(game.id).updatedAt)visible.set(game.id,game);
        games=[...visible.values()];render();return;
      }
      profile=user?{name:playerNickname(user.displayName)}:null;refreshSetupNickname();
      repository=new LocalGameRepository(user?'meridian-cloud-cache-'+user.uid:'meridian-signed-out');
      const cached=user?repository.load():[];
      const merged=new Map(remote.map(game=>[game.id,game]));
      for(const game of Array.isArray(cached)?cached:[])if(!merged.has(game.id)||game.updatedAt>=merged.get(game.id).updatedAt)merged.set(game.id,game);
      games=[...merged.values()];repository.save(games);render();
      multiplayer.sessionChanged();
      if(user){queueMicrotask(()=>{save();if(state.view!=='multiplayer')runNPCs();});}
    },
    onCommentary(gameId,eventId,result){
      const game=games.find(game=>game.id===gameId),event=game?.events.find(event=>event.id===eventId);
      if(applyCommentary(event,result)){
        repository.save(games);
        // Update the feed without interrupting the dice animation or active inputs.
        for(const node of app.querySelectorAll('[data-commentary-event]'))if(node.dataset.commentaryEvent===eventId){node.textContent='AI commentary: '+result.text;}
      }
    },
    onError(){notify('Firebase could not load your campaigns. Check your connection and Firebase setup.');}
  }).then(service=>{cloud=service;multiplayer.sessionChanged();render();}).catch(()=>{campaignLoadState='error';campaignLoadError='Firebase could not connect. Check your internet connection and retry.';render();notify(campaignLoadError);});
}

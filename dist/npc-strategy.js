// These plans spend only existing troops and the normal turn reinforcement budget.
// They are pure so resuming an older saved game needs no strategy-state migration.
import {difficultyFor} from './difficulty.js';
const holdings=(game,player)=>game.countries.filter(country=>country.owner===player);
const rewardFor=country=>Math.max(2,Math.floor(country.value/2));

function defenceGoal(countries,extra=0,level=difficultyFor()){
  if(!countries.length)return 2;
  const average=(countries.reduce((sum,country)=>sum+country.army,0)+extra)/countries.length;
  return Math.max(2,Math.floor(average*level.reserveRatio));
}

// A deterministic planning estimate: large numerical deficits are more dangerous
// than the same ratio in a tiny battle. It never changes the actual dice.
const battleConfidence=(attackers,defenders)=>1/(1+Math.exp(-1.7*(attackers-defenders)/Math.sqrt(Math.max(1,attackers+defenders))));

export class NpcStrategy {
  static reinforcements(game,player){
    const own=holdings(game,player),level=difficultyFor(game.difficulty);
    const allocations=Object.fromEntries(own.map(country=>[country.code,0]));
    const strongest=own.slice().sort((a,b)=>b.army-a.army)[0];
    if(!strongest)return {allocations,reason:'No countries remain under command.'};
    const attackingShare=Math.min(game.budget,Math.ceil(game.budget*level.offensiveShare));
    allocations[strongest.code]=attackingShare;
    let remaining=game.budget-attackingShare;
    const goal=defenceGoal(own,game.budget,level);
    // Keep an attacking force ready while retaining a small occupation reserve.
    while(remaining>0){
      const weakest=own.slice().sort((a,b)=>(a.army+allocations[a.code])-(b.army+allocations[b.code]))[0];
      if(!weakest||weakest.army+allocations[weakest.code]>=goal)break;
      allocations[weakest.code]++;remaining--;
    }
    allocations[strongest.code]+=remaining;
    const destinations=own.filter(country=>allocations[country.code]>0);
    return {allocations,reason:`Deploying ${game.budget} soldiers: ${destinations.map(country=>`${allocations[country.code]} to ${country.name}`).join(', ')}. Preparing the next offensive.`};
  }

  static defenceTransfers(game,player){
    const own=holdings(game,player).map(country=>({...country}));
    const goal=defenceGoal(own,0,difficultyFor(game.difficulty)),moves=[];
    for(const destination of own.slice().sort((a,b)=>a.army-b.army)){
      if(destination.army>=goal)continue;
      const donors=own.filter(country=>country.code!==destination.code&&country.army>goal).sort((a,b)=>b.army-a.army);
      for(const source of donors){
        const amount=Math.min(goal-destination.army,source.army-goal);
        if(amount<1)continue;
        source.army-=amount;destination.army+=amount;
        moves.push({from:source.code,to:destination.code,amount,reason:`Moving ${amount} soldiers from ${source.name} to secure ${destination.name}.`});
        if(destination.army>=goal)break;
      }
    }
    const attackingCountry=own.slice().sort((a,b)=>b.army-a.army)[0];
    if(attackingCountry){
      for(const source of own){
        if(source.code===attackingCountry.code||source.army<=goal)continue;
        const amount=source.army-goal;source.army-=amount;attackingCountry.army+=amount;
        moves.push({from:source.code,to:attackingCountry.code,amount,reason:`Moving ${amount} soldiers from ${source.name} to ${attackingCountry.name} for the next attack.`});
      }
    }
    return moves;
  }

  static attack(game,player){
    const own=holdings(game,player),enemy=game.countries.filter(country=>country.owner!==player);
    const level=difficultyFor(game.difficulty),ownCount=own.length,goal=defenceGoal(own,0,level);
    const ownArmy=own.reduce((sum,country)=>sum+country.army,0);
    const trades=new Map();
    for(const event of game.events||[]){
      if(event.type!=='conquest'||game.round-event.round<0||game.round-event.round>2)continue;
      const code=event.country||event.to;trades.set(code,(trades.get(code)||0)+1);
    }
    let best=null;
    for(const from of own){
      for(const to of enemy){
        const available=from.army-1,reward=rewardFor(to);
        // Dice remain fair. This is a planning estimate, not an altered outcome.
        const expectedCombined=from.army-to.army+reward;
        const rival=holdings(game,to.owner),eliminates=rival.length===1;
        const leading=rival.length>ownCount;
        const decisive=eliminates||leading||ownCount===1;
        const requiredRatio=decisive?level.decisiveRatio:level.attackRatio;
        if(available<to.army*requiredRatio)continue;
        if(battleConfidence(available,to.army)<(decisive?level.decisiveChance:level.minimumChance))continue;
        const recentTrades=trades.get(to.code)||0;
        const counterForce=Math.max(0,...rival.filter(country=>country.code!==to.code).map(country=>country.army-1));
        const expectedGarrison=Math.max(2,Math.min(goal,Math.floor(expectedCombined/2)));
        const counterRisk=Math.min(3,Math.max(0,counterForce-expectedGarrison)*.1);
        const combatCost=4*to.army/Math.max(1,available);
        const rivalArmy=rival.reduce((sum,country)=>sum+country.army,0);
        const armyThreat=Math.min(3,Math.max(0,rivalArmy-ownArmy)/Math.max(1,ownArmy));
        const nextArmy=Math.max(0,expectedCombined-goal+2*(ownCount+1)*level.offensiveShare-1);
        const followUps=level.momentumWeight?Math.min(3,enemy.filter(country=>country.code!==to.code&&nextArmy>=country.army*level.attackRatio).length):0;
        const playerPressure=player!==0&&to.owner===0?level.playerPressure:0;
        const score=4+reward*1.2-combatCost+Math.min(12,Math.max(0,expectedCombined))*.25+(eliminates?level.eliminationWeight:0)+Math.max(0,rival.length-ownCount)*level.leaderWeight+armyThreat*level.threatWeight+followUps*level.momentumWeight+playerPressure-Math.min(3,recentTrades)*level.churnPenalty-counterRisk*level.counterWeight;
        if(!best||score>best.score){
          const objective=eliminates?'eliminate a rival commander':leading?'challenge the leading rival':`expand our territory and gain ${reward} soldiers`;
          best={from,to,score,reason:`Attack ${to.name} to ${objective}: ${available} attackers against ${to.army} defenders.`};
        }
      }
    }
    if(best)return best;
    return {reason:'Holding this turn: more soldiers are needed to challenge an enemy army.'};
  }

  static battleDecision(game){
    const battle=game.battle;
    if(!battle)return {continue:false,reason:'No attack is in progress.'};
    const from=game.countries.find(country=>country.code===battle.from),to=game.countries.find(country=>country.code===battle.to);
    const level=difficultyFor(game.difficulty),eliminates=holdings(game,to.owner).length===1;
    const viable=from.army>1&&from.army-1>=to.army*(eliminates?level.finishRatio:level.continueRatio)&&battleConfidence(from.army-1,to.army)>=level.retreatChance;
    return {continue:viable,reason:viable?'Pressing the attack while victory remains within reach.':`Ending the attack on ${to.name} after heavy losses.`};
  }
}

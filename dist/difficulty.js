export const difficultyOptions=Object.freeze([
  {id:'easy',label:'Easy',colour:'#2DD4BF',description:'Forgiving rivals. More room to learn.',offensiveShare:.5,reserveRatio:.65,attackRatio:1.3,decisiveRatio:1.15,continueRatio:1,finishRatio:.85,eliminationWeight:4,leaderWeight:.5,churnPenalty:.75,counterWeight:.5,momentumWeight:0,threatWeight:0,playerPressure:-2,minimumChance:0,decisiveChance:0,retreatChance:0},
  {id:'medium',label:'Medium',colour:'#D4AF37',description:'Balanced rivals that take close fights.',offensiveShare:.65,reserveRatio:.5,attackRatio:1,decisiveRatio:.9,continueRatio:.65,finishRatio:.5,eliminationWeight:12,leaderWeight:1.6,churnPenalty:1.25,counterWeight:1,momentumWeight:0,threatWeight:0,playerPressure:0,minimumChance:0,decisiveChance:0,retreatChance:0},
  {id:'hard',label:'Hard',colour:'#F68FA1',description:'Sharper strategy and more pressure.',offensiveShare:.8,reserveRatio:.45,attackRatio:.95,decisiveRatio:.85,continueRatio:.6,finishRatio:.45,eliminationWeight:16,leaderWeight:2.2,churnPenalty:1.75,counterWeight:1.25,momentumWeight:1.2,threatWeight:1.5,playerPressure:1.2,minimumChance:.35,decisiveChance:.25,retreatChance:.08},
  {id:'extreme',label:'Extreme',colour:'#D5A0EC',description:'Relentless rivals that seek you out.',offensiveShare:.9,reserveRatio:.4,attackRatio:.9,decisiveRatio:.8,continueRatio:.55,finishRatio:.4,eliminationWeight:20,leaderWeight:3,churnPenalty:2,counterWeight:1.5,momentumWeight:2.4,threatWeight:3,playerPressure:3,minimumChance:.3,decisiveChance:.25,retreatChance:.1}
].map(level=>Object.freeze(level)));

// Missing or unrecognised settings use the previous balanced strategy.
export const difficultyFor=id=>difficultyOptions.find(level=>level.id===id)||difficultyOptions[1];

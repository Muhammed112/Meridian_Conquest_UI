export function normalizeNickname(value){
  const nickname=typeof value==='string'?value.trim():'';
  if(nickname.length<2||nickname.length>32||/[\u0000-\u001f\u007f]/.test(nickname))throw Object.assign(new Error('Choose a player nickname between 2 and 32 characters.'),{code:'profile/invalid-nickname'});
  return nickname;
}
// Older accounts may have longer display names or no nickname yet.
export const playerNickname=value=>typeof value==='string'&&value.trim()?value.trim().replace(/[\u0000-\u001f\u007f]/g,'').slice(0,32)||'Commander':'Commander';

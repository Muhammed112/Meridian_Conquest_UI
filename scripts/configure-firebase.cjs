// Uses the existing Firebase CLI sign-in; never prints or persists access tokens.
const path=require('node:path');
const auth=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
const project='meridian-conquest-m112';
async function main(){
  const account=auth.getGlobalDefaultAccount();
  if(!account)throw new Error('Sign in with firebase login first');
  const token=await auth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
  async function api(url,method='GET',body){
    const response=await fetch(url,{method,headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const data=await response.json();
    if(!response.ok)throw new Error(response.status+': '+(data.error?.message||'Request failed'));
    return data;
  }
  const action=process.argv[2];
  if(action==='services'){
    const op=await api('https://serviceusage.googleapis.com/v1/projects/'+project+'/services:batchEnable','POST',{serviceIds:['firestore.googleapis.com','identitytoolkit.googleapis.com','firebaserules.googleapis.com']});
    console.log('Services enable operation:',op.name);
    for(let n=0;n<30;n++){
      const status=await api('https://serviceusage.googleapis.com/v1/'+op.name);
      if(status.error)throw new Error(status.error.message);
      if(status.done){console.log('Firebase APIs enabled');return;}
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw new Error('Service activation is still pending');
  }else if(action==='auth'){
    const base='https://identitytoolkit.googleapis.com/admin/v2/projects/'+project+'/config';
    const old=await api(base);
    const domains=[...new Set([...(old.authorizedDomains||[]),'localhost',project+'.firebaseapp.com',project+'.web.app'])];
    const updated=await api(base+'?updateMask=signIn.email,authorizedDomains','PATCH',{signIn:{email:{enabled:true,passwordRequired:true}},authorizedDomains:domains});
    console.log('Email/password enabled:',updated.signIn?.email?.enabled===true);
    console.log('Authorized domains:',updated.authorizedDomains?.join(', '));
  }else if(action==='billing'){
    const data=await api('https://cloudbilling.googleapis.com/v1/projects/'+project+'/billingInfo');
    console.log('Billing enabled:',data.billingEnabled===true);
  }else throw new Error('Use services, auth or billing');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

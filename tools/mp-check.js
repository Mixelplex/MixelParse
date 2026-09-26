const fs=require('fs');const h=fs.readFileSync(process.argv[2],'utf8');
const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;let m,i=0,bad=0;
while((m=re.exec(h))){i++;try{new Function(m[1]);}catch(e){bad++;console.log('script #'+i+': '+e.message);}}
console.log(i+' inline scripts, '+bad+' with syntax errors');


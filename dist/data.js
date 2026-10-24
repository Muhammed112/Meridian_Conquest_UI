export const colours = ['#2DD4BF','#E6AE57','#8C9EFF','#F68FA1','#A5CE72','#D5A0EC','#73B9E8','#DCC684','#E09B75','#9FAABF'];
export const commanders = ['You','Kestrel','Atlas','Vesper','Orion','Flint','Sable','Rook','Nova','Echo'];
// Illustrative population values for the interface. Replace with a dated catalogue on backend integration.
export const catalogue = [
  {id:'710',code:'ZA',name:'South Africa',flag:'🇿🇦',population:64.7,lon:25,lat:-29},
  {id:'076',code:'BR',name:'Brazil',flag:'🇧🇷',population:212.8,lon:-51,lat:-10},
  {id:'840',code:'US',name:'United States',flag:'🇺🇸',population:347.3,lon:-99,lat:39},
  {id:'826',code:'GB',name:'United Kingdom',flag:'🇬🇧',population:69.6,lon:-3,lat:54},
  {id:'578',code:'NO',name:'Norway',flag:'🇳🇴',population:5.6,lon:10,lat:64},
  {id:'818',code:'EG',name:'Egypt',flag:'🇪🇬',population:118.4,lon:30,lat:27},
  {id:'356',code:'IN',name:'India',flag:'🇮🇳',population:1463.9,lon:79,lat:22},
  {id:'392',code:'JP',name:'Japan',flag:'🇯🇵',population:123.1,lon:138,lat:37},
  {id:'036',code:'AU',name:'Australia',flag:'🇦🇺',population:27,lon:134,lat:-25},
  {id:'124',code:'CA',name:'Canada',flag:'🇨🇦',population:40.1,lon:-107,lat:58},
  {id:'276',code:'DE',name:'Germany',flag:'🇩🇪',population:84.1,lon:10,lat:51},
  {id:'250',code:'FR',name:'France',flag:'🇫🇷',population:66.7,lon:2,lat:46},
  {id:'156',code:'CN',name:'China',flag:'🇨🇳',population:1416.1,lon:104,lat:35},
  {id:'484',code:'MX',name:'Mexico',flag:'🇲🇽',population:131.9,lon:-102,lat:24},
  {id:'032',code:'AR',name:'Argentina',flag:'🇦🇷',population:45.9,lon:-64,lat:-35},
  {id:'566',code:'NG',name:'Nigeria',flag:'🇳🇬',population:237.5,lon:8,lat:9},
  {id:'404',code:'KE',name:'Kenya',flag:'🇰🇪',population:57.5,lon:37,lat:1},
  {id:'554',code:'NZ',name:'New Zealand',flag:'🇳🇿',population:5.3,lon:173,lat:-41},
  {id:'380',code:'IT',name:'Italy',flag:'🇮🇹',population:59.1,lon:12,lat:43},
  {id:'724',code:'ES',name:'Spain',flag:'🇪🇸',population:47.9,lon:-4,lat:40},
  {id:'752',code:'SE',name:'Sweden',flag:'🇸🇪',population:10.7,lon:16,lat:63},
  {id:'360',code:'ID',name:'Indonesia',flag:'🇮🇩',population:285.7,lon:118,lat:-4},
  {id:'682',code:'SA',name:'Saudi Arabia',flag:'🇸🇦',population:34.6,lon:45,lat:24},
  {id:'152',code:'CL',name:'Chile',flag:'🇨🇱',population:19.9,lon:-71,lat:-33},
];
export const armyValue = population => [5,10,25,50,75,100,125,150,Infinity].findIndex(max=>population<=max)+1;
export const findCountry = code => catalogue.find(country=>country.code===code);
export const flag = code => findCountry(code)?.flag || '🌐';
export const initials = name => name.split(' ').map(x=>x[0]).slice(0,2).join('').toUpperCase();

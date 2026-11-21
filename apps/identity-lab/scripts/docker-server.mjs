import {createLabServer} from '../server.mjs';
const {server}=createLabServer();
server.listen(Number(process.env.PORT||8787),'0.0.0.0',()=>console.log('Identity Lab listening on container port 8787'));

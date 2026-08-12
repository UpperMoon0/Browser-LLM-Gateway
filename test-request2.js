import http from 'http';

async function run() {
  const req = http.request('http://127.0.0.1:11436/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer local'
    }
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      console.log(JSON.stringify(JSON.parse(body), null, 2));
    });
  });

  req.on('error', (e) => console.error(e));

  req.write(JSON.stringify({
    model: 'chatgpt-web',
    messages: [{ role: 'user', content: 'What is 1+2? Keep it extremely short.' }]
  }));
  req.end();
}

run();

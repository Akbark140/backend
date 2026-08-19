const loginUser = async () => {

  const res = await request(app)
    .post('/api/auth/login')
    .send({
      email: 'test@test.com',
      password: '123456'
    });

  return res.body.token;
};
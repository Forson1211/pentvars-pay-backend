async function test() {
    try {
        console.log('Logging in...');
        const loginRes = await fetch('http://localhost:5000/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'admin@pentvarsuniversity.edu.gh',
                password: 'admin123'
            })
        });
        const loginData = await loginRes.json() as any;
        const token = loginData.token;
        if (!token) {
            console.error('Login failed');
            return;
        }

        console.log('Fetching templates...');
        const templatesRes = await fetch('http://localhost:5000/api/admin/fee-templates', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const templates = await templatesRes.json() as any[];
        console.log(`Fetched ${templates.length} templates.`);

        if (templates.length > 0) {
            const sample = templates[0];
            console.log('\nSample template structure:');
            console.log('ID:', sample.id);
            console.log('academicYear type:', typeof sample.academicYear);
            console.log('academicYear value:', sample.academicYear);
        }
    } catch (err: any) {
        console.error('ERROR:', err);
    }
}

test();
